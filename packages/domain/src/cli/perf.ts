/**
 * `npm run perf`: latency of key domain operations (W3.7 / Phase 5
 * "Validate: latency"). Prints p50/p95 per operation and nothing else: no
 * latency target has been agreed (P12), so this reports numbers without
 * judging them.
 *
 * Runs against a fresh in-memory PGlite database, migrated and seeded with
 * the standard fixtures plus extra published briefings, using the
 * deterministic AI provider. Options:
 *   --iterations <n>   samples per operation (default 50; a sampling choice, not a target)
 *   --briefings <n>    extra published briefings in the library (default 25)
 *   --json             machine-readable output
 */
import { strategyBriefing, type BriefingDocument } from "@cerebro/briefing-schema";
import { createTestDatabase, runBriefingSeedHook, seedOrganizations, type SeedUserKey } from "@cerebro/database";
import { randomUUID } from "node:crypto";
import { createBriefing, getBriefingMeta, getDraft, getRevisionDocument, updateDraft } from "../briefings/index";
import type { RequestContext } from "../context";
import { askQuestion } from "../engagement/index";
import { runJobsOnce } from "../jobs/runner";
import { listLibrary } from "../library/index";
import { createPreview, publishBriefing } from "../publication/index";

const args = process.argv.slice(2);
const opt = (name: string, def: number) => {
  const i = args.indexOf(`--${name}`);
  const n = i >= 0 ? Number(args[i + 1]) : def;
  return Number.isInteger(n) && n > 0 ? n : def;
};
const ITERATIONS = opt("iterations", 50);
const EXTRA_BRIEFINGS = opt("briefings", 25);
const JSON_OUT = args.includes("--json");

// Keep operational logs out of the measurement output.
process.env.LOG_LEVEL ??= "silent";

const h = await createTestDatabase();
const seed = await seedOrganizations(h.db);
await runBriefingSeedHook(h, seed);
const org = seed.orgs.acme.id;
const ctx = (user: SeedUserKey): RequestContext => ({ userId: seed.users[user], organizationId: org, via: "web", requestId: randomUUID() });

async function drain() {
  for (let i = 0; i < 100; i++) if ((await runJobsOnce(h.db, { workerId: "perf", limit: 20 })).claimed === 0) return;
}

async function publishNew(doc: BriefingDocument, title: string) {
  const c = ctx("riley");
  const created = await createBriefing(h.db, c, { document: { ...doc, title }, home: {}, audience: { visibility: "company" } });
  const approve = doc.evidence.filter((e) => e.status === "approved").map((e) => e.id);
  if (approve.length) {
    await updateDraft(h.db, c, {
      briefingId: created.briefingId,
      expectedVersion: created.draftVersion,
      patch: approve.map((evidenceId) => ({ op: "set_evidence_status" as const, evidenceId, status: "approved" as const })),
    });
  }
  const preview = await createPreview(h.db, c, { briefingId: created.briefingId });
  await publishBriefing(h.db, c, { briefingId: created.briefingId, previewId: preview.previewId });
  return created.briefingId;
}

const target = await publishNew(strategyBriefing, "Performance target briefing");
for (let i = 0; i < EXTRA_BRIEFINGS; i++) await publishNew(strategyBriefing, `Library filler ${i + 1}`);
await drain();

interface Stat {
  operation: string;
  n: number;
  p50Ms: number;
  p95Ms: number;
  meanMs: number;
  maxMs: number;
}

function stats(operation: string, samples: number[]): Stat {
  const s = [...samples].sort((a, b) => a - b);
  // Nearest-rank percentiles.
  const pct = (p: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
  const round = (n: number) => Math.round(n * 10) / 10;
  return {
    operation,
    n: s.length,
    p50Ms: round(pct(50)),
    p95Ms: round(pct(95)),
    meanMs: round(s.reduce((a, b) => a + b, 0) / s.length),
    maxMs: round(s[s.length - 1]!),
  };
}

async function measure(operation: string, fn: (i: number) => Promise<unknown>, setup?: (i: number) => Promise<void>): Promise<Stat> {
  // One warm-up call, not recorded.
  await setup?.(-1);
  await fn(-1);
  const samples: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    await setup?.(i);
    const t = performance.now();
    await fn(i);
    samples.push(performance.now() - t);
  }
  return stats(operation, samples);
}

const readers: SeedUserKey[] = ["alex", "priya", "jordan", "sam", "maya", "riley"];
const reader = (i: number) => ctx(readers[(i + readers.length) % readers.length]!);
const QUESTIONS = [
  "What net revenue retention did mid-market accounts record?",
  "What decision is being requested?",
  "What are the main risks?",
  "Who owns the next steps?",
];

const results: Stat[] = [];
results.push(await measure("library.list (company, first page)", (i) => listLibrary(h.db, reader(i), { scope: { kind: "company" } })));
results.push(
  await measure("reader.open (meta + current revision)", async (i) => {
    const c = reader(i);
    await getBriefingMeta(h.db, c, { briefingId: target });
    await getRevisionDocument(h.db, c, { briefingId: target });
  }),
);
results.push(
  await measure("qa.answer (deterministic provider)", (i) =>
    askQuestion(h.db, reader(i), { briefingId: target, question: QUESTIONS[(i + QUESTIONS.length) % QUESTIONS.length]! }),
  ),
);

let previewId = "";
const author = ctx("riley");
const preparePreview = async (i: number) => {
  const draft = await getDraft(h.db, author, target);
  await updateDraft(h.db, author, {
    briefingId: target,
    expectedVersion: draft.lockVersion,
    document: { ...draft.document, position: { ...draft.document.position, headline: `${strategyBriefing.position.headline} (${i + 2})` } },
  });
};
results.push(
  await measure(
    "publication.preview",
    async () => {
      previewId = (await createPreview(h.db, author, { briefingId: target })).previewId;
    },
    preparePreview,
  ),
);
results.push(
  await measure(
    "publication.publish",
    () => publishBriefing(h.db, author, { briefingId: target, previewId }),
    async (i) => {
      await preparePreview(i + 10_000);
      previewId = (await createPreview(h.db, author, { briefingId: target })).previewId;
    },
  ),
);

await h.close();

if (JSON_OUT) {
  console.log(JSON.stringify({ database: "pglite (in-memory)", node: process.version, iterations: ITERATIONS, extraBriefings: EXTRA_BRIEFINGS, results }, null, 2));
} else {
  console.log(`Cerebro domain latency — PGlite in-memory, Node ${process.version}, ${ITERATIONS} samples per operation, ${EXTRA_BRIEFINGS} extra briefings.`);
  console.log("Measured numbers only; no latency targets are agreed (P12).\n");
  const w = Math.max(...results.map((r) => r.operation.length));
  console.log(`${"operation".padEnd(w)}  ${"n".padStart(4)}  ${"p50 ms".padStart(8)}  ${"p95 ms".padStart(8)}  ${"mean ms".padStart(8)}  ${"max ms".padStart(8)}`);
  for (const r of results) {
    console.log(
      `${r.operation.padEnd(w)}  ${String(r.n).padStart(4)}  ${r.p50Ms.toFixed(1).padStart(8)}  ${r.p95Ms.toFixed(1).padStart(8)}  ${r.meanMs.toFixed(1).padStart(8)}  ${r.maxMs.toFixed(1).padStart(8)}`,
    );
  }
}
