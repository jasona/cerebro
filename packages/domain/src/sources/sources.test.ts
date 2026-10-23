import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceChunks, sources, withSystemContext } from "@cerebro/database";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildDocx } from "../../../capture/test/fixtures";
import { getDraft } from "../briefings/index";
import { DomainError } from "../errors";
import { drainJobs, makePublishedBriefing } from "../engagement/test-fixtures";
import { createTestWorld, type TestWorld } from "../testing";
import { addSource, createEvidenceFromChunk, getSourceExtraction, LocalSourceStore, setSourceStore } from "./index";

let w: TestWorld;
let objects: string;
beforeEach(async () => {
  w = await createTestWorld();
  objects = await mkdtemp(join(tmpdir(), "cerebro-objects-"));
  setSourceStore(new LocalSourceStore(objects));
});
afterEach(async () => {
  setSourceStore(undefined);
  await w.h.close();
  await rm(objects, { recursive: true, force: true });
});

const isCode = (code: string) => (e: unknown) => e instanceof DomainError && e.code === code;

describe("extract_source", () => {
  it("extracts inline text into chunks with locators", async () => {
    const fb = await makePublishedBriefing(w);
    const src = await addSource(w.h.db, w.ctx("maya"), {
      briefingId: fb.id,
      kind: "markdown",
      title: "Notes",
      text: "# Pilot\n\nThe pilot needs a dedicated pod.\n\n# Risks\n\nSupport capacity is limited.",
      origin: "llm_handoff",
      attribution: "ChatGPT conversation",
    });
    expect(src.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
    let ex = await getSourceExtraction(w.h.db, w.ctx("maya"), src.sourceId);
    expect(ex.status).toBe("pending");
    await drainJobs(w);
    ex = await getSourceExtraction(w.h.db, w.ctx("maya"), src.sourceId);
    expect(ex).toMatchObject({ status: "succeeded", completeness: "complete", captureKind: "markdown", origin: "llm_handoff" });
    expect(ex.chunkCount).toBeGreaterThan(0);
    expect(ex.chunks[0]!.locator).toBeTruthy();

    // Readers and company admins without edit get nothing.
    await expect(getSourceExtraction(w.h.db, w.ctx("alex"), src.sourceId)).rejects.toSatisfy(isCode("not_found"));
    await expect(getSourceExtraction(w.h.db, w.ctx("riley"), src.sourceId)).rejects.toSatisfy(isCode("not_found"));
  });

  it("stores docx bytes privately by content hash and extracts them", async () => {
    const fb = await makePublishedBriefing(w);
    const bytes = await buildDocx(["Quarterly review of onboarding.", "Median time to value fell to 41 days."]);
    const src = await addSource(w.h.db, w.ctx("maya"), { briefingId: fb.id, kind: "docx", filename: "review.docx", bytes, origin: "upload" });
    const [row] = await withSystemContext(w.h.db, (tx) => tx.select().from(sources).where(eq(sources.id, src.sourceId)));
    expect(row!.textContent).toBeNull();
    expect(row!.objectKey).toBe(`${w.seed.orgs.acme.id}/${src.checksum.slice("sha256:".length)}`);
    expect(existsSync(join(objects, row!.objectKey!))).toBe(true);

    await drainJobs(w);
    const ex = await getSourceExtraction(w.h.db, w.ctx("maya"), src.sourceId);
    expect(ex.status).toBe("succeeded");
    expect(ex.captureKind).toBe("docx");
    const chunks = await withSystemContext(w.h.db, (tx) => tx.select().from(sourceChunks).where(eq(sourceChunks.sourceId, src.sourceId)));
    expect(chunks.map((c) => c.text).join(" ")).toContain("41 days");
    expect(chunks[0]!.locator).toMatch(/Paragraph/);
  });

  it("rejects invalid uploads and requires edit on the briefing", async () => {
    const fb = await makePublishedBriefing(w);
    await expect(
      addSource(w.h.db, w.ctx("maya"), { briefingId: fb.id, kind: "docx", bytes: new TextEncoder().encode("plain text"), origin: "upload" }),
    ).rejects.toSatisfy(isCode("validation"));
    await expect(addSource(w.h.db, w.ctx("alex"), { briefingId: fb.id, kind: "text", text: "hello", origin: "manual" })).rejects.toSatisfy(
      isCode("forbidden"),
    );
  });
});

describe("createEvidenceFromChunk", () => {
  it("adds a candidate with sourceRef under optimistic concurrency", async () => {
    const fb = await makePublishedBriefing(w);
    const src = await addSource(w.h.db, w.ctx("maya"), { briefingId: fb.id, kind: "text", text: "Churn fell by four points.", origin: "manual" });
    await drainJobs(w);
    const ex = await getSourceExtraction(w.h.db, w.ctx("maya"), src.sourceId);
    const chunkId = ex.chunks[0]!.id;
    const res = await createEvidenceFromChunk(w.h.db, w.ctx("maya"), { briefingId: fb.id, expectedVersion: 1, chunkId, title: "Churn note" });
    expect(res).toMatchObject({ status: "candidate", lockVersion: 2 });
    const draft = await getDraft(w.h.db, w.ctx("maya"), fb.id);
    expect(JSON.stringify(draft)).toContain(res.evidenceId);

    await expect(
      createEvidenceFromChunk(w.h.db, w.ctx("maya"), { briefingId: fb.id, expectedVersion: 1, chunkId, title: "Again" }),
    ).rejects.toSatisfy(isCode("conflict"));
  });
});
