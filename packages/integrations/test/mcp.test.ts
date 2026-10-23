import {
  addTeamMember,
  askQuestion,
  createBriefing,
  createTeam,
  getRevisionDocument,
  listLibrary,
  listMyDrafts,
  revokeConnection,
  submitFeedback,
} from "@cerebro/domain";
import { briefingRevisions, withSystemContext } from "@cerebro/database";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestWorld, type TestWorld } from "../../domain/src/testing";
import { drainJobs } from "../../domain/src/engagement/test-fixtures";
import { handleMcpHttpRequest } from "../src/index";
import { APP_URL, connect, connectWithToken, MCP_URL, platformHandoff, type Connected } from "./helpers";

let w: TestWorld;
let mcp: Connected;

beforeEach(async () => {
  w = await createTestWorld();
  mcp = await connect(w, "maya");
});
afterEach(async () => {
  await mcp.close().catch(() => undefined);
  await w.h.close();
});

let keyN = 0;
const key = () => `test-key-${++keyN}-${Math.random().toString(36).slice(2)}`;

async function createDraft(handoff = platformHandoff(), idempotency_key = key()) {
  const r = await mcp.call("create_brief_draft", { handoff, idempotency_key });
  expect(r.isError, r.text).toBeFalsy();
  expect(r.sc.status).toBe("draft");
  return r;
}

describe("tool surface", () => {
  it("lists the proposed tools with publish annotations and a publish-only-on-request description", async () => {
    const { tools } = await mcp.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "create_brief_draft",
        "find_briefs",
        "get_author_feedback",
        "get_authoring_context",
        "get_brief",
        "get_operation",
        "preview_brief",
        "publish_brief",
        "update_brief_draft",
      ].sort(),
    );
    const publish = tools.find((t) => t.name === "publish_brief")!;
    expect(publish.annotations).toMatchObject({ destructiveHint: false, idempotentHint: true, openWorldHint: false, readOnlyHint: false });
    expect(publish.description).toMatch(/ONLY after the human has seen the preview/);
    // The real handoff JSON Schema is published to the host; no credential arguments anywhere.
    const create = tools.find((t) => t.name === "create_brief_draft")!;
    const handoffSchema = (create.inputSchema.properties as Record<string, any>).handoff;
    expect(handoffSchema.properties.handoffVersion).toBeTruthy();
    expect(JSON.stringify(tools.map((t) => t.inputSchema))).not.toMatch(/token|password|secret/i);
  });

  it("get_authoring_context returns the company, destinations and preferences", async () => {
    const r = await mcp.call("get_authoring_context");
    expect(r.isError).toBeFalsy();
    expect(r.sc.company.name).toBe("Acme");
    expect(r.sc.destinations.teams.map((t: any) => t.label)).toContain("Acme / Product / Platform");
    expect(r.sc.default_visibility).toBe("company");
    expect(r.text).toContain("bound to this company only");
  });
});

describe("end-to-end: connect → resolve → draft → preview → approve → re-preview → publish → discover", () => {
  it("publishes only approved evidence and the brief is discoverable by a colleague", async () => {
    const created = await createDraft();
    const briefingId = created.sc.briefing_id as string;
    expect(created.sc.home.label).toBe("Acme / Product / Platform");
    expect(created.sc.audience).toMatchObject({ visibility: "company", defaulted: true });
    expect(created.sc.evidence_candidates).toHaveLength(2);
    expect(created.sc.evidence_candidates.every((e: any) => e.status === "candidate")).toBe(true);
    expect(created.text).toContain("Proposed audience: Everyone at Acme (company-wide, the default)");

    // A private draft is not in the library.
    expect((await listLibrary(w.h.db, w.ctx("alex"))).items.map((i) => i.briefingId)).not.toContain(briefingId);

    // First preview: no approved evidence, audience stated explicitly, authenticated link, explicit-publish guard.
    const p1 = await mcp.call("preview_brief", { briefing_id: briefingId });
    expect(p1.isError).toBeFalsy();
    expect(p1.text).toContain("Audience: Everyone at Acme (company-wide)");
    expect(p1.text).toContain("Home: Acme / Product / Platform");
    expect(p1.text).toContain("No supporting evidence attached");
    expect(p1.text).toContain("Candidates awaiting the author's approval");
    expect(p1.text).toMatch(/explicitly asks to publish/);
    const slug = created.sc.slug as string;
    const link = `${APP_URL}/c/${w.seed.orgs.acme.slug}/b/${slug}/preview`;
    expect(p1.text).toContain(`Review in Cerebro (sign-in required): ${link}`);
    expect(p1.sc.preview_url).toBe(link);
    expect(p1.sc.no_supporting_evidence).toBe(true);
    // Missing evidence is a warning, not an error.
    expect(p1.sc.warnings.some((i: any) => i.code === "no_approved_evidence")).toBe(true);
    expect(p1.sc.claims_without_evidence.length).toBeGreaterThan(0);
    expect(p1.text).toContain("Claims publishing without evidence");

    // Author approves one candidate and excludes the other.
    const [good, weak] = created.sc.evidence_candidates as { id: string; title: string }[];
    expect(good!.title).toBe("Delivery review");
    const upd = await mcp.call("update_brief_draft", {
      briefing_id: briefingId,
      expected_version: 1,
      evidence_decisions: [
        { evidence_id: good!.id, status: "approved" },
        { evidence_id: weak!.id, status: "excluded" },
      ],
      idempotency_key: key(),
    });
    expect(upd.isError, upd.text).toBeFalsy();
    expect(upd.sc.draft_version).toBe(2);

    // The earlier preview is stale now.
    const stale = await mcp.call("publish_brief", { briefing_id: briefingId, preview_id: p1.sc.preview_id, idempotency_key: key() });
    expect(stale.isError).toBe(true);
    expect(stale.sc.error.code).toBe("stale_preview");
    expect(stale.sc.error.details.reasons).toContain("evidence");

    const p2 = await mcp.call("preview_brief", { briefing_id: briefingId });
    expect(p2.sc.evidence.approved.map((e: any) => e.id)).toEqual([good!.id]);
    expect(p2.sc.evidence.excluded.map((e: any) => e.id)).toEqual([weak!.id]);
    expect(p2.text).toContain("Approved evidence that will be published (1)");
    expect(p2.sc.can_publish).toBe(true);

    const publishKey = key();
    const pub = await mcp.call("publish_brief", { briefing_id: briefingId, preview_id: p2.sc.preview_id, idempotency_key: publishKey });
    expect(pub.isError, pub.text).toBeFalsy();
    expect(pub.sc).toMatchObject({
      status: "published",
      replayed: false,
      revision_number: 1,
      canonical_url: `${APP_URL}/c/${w.seed.orgs.acme.slug}/b/${slug}`,
    });

    // Timed-out retry of the publish: same result, no second revision.
    const retry = await mcp.call("publish_brief", { briefing_id: briefingId, preview_id: p2.sc.preview_id, idempotency_key: publishKey });
    expect(retry.sc).toMatchObject({ status: "published", replayed: true, revision_number: 1, publication_id: pub.sc.publication_id });
    // Same preview with a new key: the domain returns the original publication.
    const again = await mcp.call("publish_brief", { briefing_id: briefingId, preview_id: p2.sc.preview_id, idempotency_key: key() });
    expect(again.sc).toMatchObject({ replayed: true, revision_number: 1 });
    const revs = await withSystemContext(w.h.db, (tx) => tx.select().from(briefingRevisions).where(eq(briefingRevisions.briefingId, briefingId)));
    expect(revs).toHaveLength(1);

    // Only the approved candidate reached the revision; the perspective was carried through.
    const rev = await getRevisionDocument(w.h.db, w.ctx("alex"), { briefingId });
    expect(rev.evidence.map((e) => e.id)).toEqual([good!.id]);
    expect(rev.document.perspectives.map((p) => p.label)).toEqual(["Finance"]);

    // Discoverable by another member in company and team views.
    const company = await listLibrary(w.h.db, w.ctx("alex"));
    expect(company.items.map((i) => i.briefingId)).toContain(briefingId);
    const team = await listLibrary(w.h.db, w.ctx("alex"), { scope: { kind: "team", teamId: w.seed.orgs.acme.teams.platform! } });
    expect(team.items.map((i) => i.briefingId)).toContain(briefingId);

    // find_briefs and get_brief from the host.
    const found = await mcp.call("find_briefs", { query: "platform roadmap" });
    expect(found.sc.briefs.map((b: any) => b.briefing_id)).toContain(briefingId);
    const got = await mcp.call("get_brief", { briefing_id: briefingId });
    expect(got.sc).toMatchObject({ view: "published", revision: { revisionNumber: 1 }, draft_version: 2 });
    const draft = await mcp.call("get_brief", { briefing_id: briefingId, view: "draft" });
    expect(draft.sc.draft_version).toBe(2);

    // get_operation re-reads the publish operation.
    const opr = await mcp.call("get_operation", { operation_id: pub.sc.operation_id });
    expect(opr.sc).toMatchObject({ action: "publish_brief", status: "succeeded" });

    // A reader without view_draft cannot get the draft.
    const alex = await connect(w, "alex");
    const denied = await alex.call("get_brief", { briefing_id: briefingId, view: "draft" });
    expect(denied.isError).toBe(true);
    expect(["not_found", "forbidden"]).toContain(denied.sc.error.code);
    await alex.close();
  });

  it("states a non-default audience explicitly", async () => {
    const created = await createDraft(platformHandoff({ audience: { visibility: "team" } }));
    expect(created.sc.audience).toMatchObject({ visibility: "team", label: "Platform team", defaulted: false });
    const p = await mcp.call("preview_brief", { briefing_id: created.sc.briefing_id });
    expect(p.text).toContain("Audience: Platform team only");
  });

  it("updates conversationally from a new handoff, preserving evidence ids and approvals, and shows the diff", async () => {
    const created = await createDraft();
    const id = created.sc.briefing_id as string;
    const good = created.sc.evidence_candidates[0].id as string;
    await mcp.call("update_brief_draft", { briefing_id: id, expected_version: 1, evidence_decisions: [{ evidence_id: good, status: "approved" }], idempotency_key: key() });
    const p = await mcp.call("preview_brief", { briefing_id: id });
    await mcp.call("publish_brief", { briefing_id: id, preview_id: p.sc.preview_id, idempotency_key: key() });

    const revised = platformHandoff({
      position: { headline: "Consolidate onto one platform roadmap by Q3", summary: "Revised timing after the review." },
      evidence: [
        (platformHandoff().evidence as unknown[])[0],
        { title: "New excerpt", excerpt: "A newly supplied excerpt.", attribution: "Planning doc" },
      ],
      destination: undefined,
    });
    const upd = await mcp.call("update_brief_draft", { briefing_id: id, expected_version: 2, handoff: revised, idempotency_key: key() });
    expect(upd.isError, upd.text).toBeFalsy();
    const byTitle = Object.fromEntries((upd.sc.evidence as any[]).map((e) => [e.title, e]));
    expect(byTitle["Delivery review"]).toMatchObject({ id: good, status: "approved" });
    expect(byTitle["New excerpt"].status).toBe("candidate");

    // A full document cannot self-approve new evidence.
    const draft = await mcp.call("get_brief", { briefing_id: id, view: "draft" });
    const doc = draft.sc.document;
    doc.evidence.push({ id: "ev_injected01", title: "Injected", excerpt: "Self-approved?", origin: "llm_handoff", status: "approved" });
    const upd2 = await mcp.call("update_brief_draft", { briefing_id: id, expected_version: draft.sc.draft_version, document: doc, idempotency_key: key() });
    expect(upd2.isError, upd2.text).toBeFalsy();
    expect((upd2.sc.evidence as any[]).find((e) => e.id === "ev_injected01").status).toBe("candidate");

    const p2 = await mcp.call("preview_brief", { briefing_id: id });
    expect(p2.sc.current_revision_number).toBe(1);
    expect(p2.sc.change_summary.join(" ")).not.toBe("First publication.");
    expect(p2.text).toContain("Change summary:");
  });
});

describe("idempotency", () => {
  it("a timed-out create retried with the same key returns the same brief; a different payload is a mismatch", async () => {
    const k = key();
    const a = await createDraft(platformHandoff(), k);
    const b = await mcp.call("create_brief_draft", { handoff: platformHandoff(), idempotency_key: k });
    expect(b.sc).toMatchObject({ briefing_id: a.sc.briefing_id, replayed: true });
    expect(await listMyDrafts(w.h.db, w.ctx("maya"))).toHaveLength(1);

    const c = await mcp.call("create_brief_draft", { handoff: platformHandoff({ title: "Something else" }), idempotency_key: k });
    expect(c.isError).toBe(true);
    expect(c.sc.error.code).toBe("idempotency_mismatch");
    expect(await listMyDrafts(w.h.db, w.ctx("maya"))).toHaveLength(1);
  });

  it("a retried update with the same key does not apply twice", async () => {
    const created = await createDraft();
    const id = created.sc.briefing_id;
    const k = key();
    const args = { briefing_id: id, expected_version: 1, evidence_decisions: [{ evidence_id: created.sc.evidence_candidates[0].id, status: "approved" }], idempotency_key: k };
    const first = await mcp.call("update_brief_draft", args);
    const second = await mcp.call("update_brief_draft", args);
    expect(first.sc.draft_version).toBe(2);
    expect(second.sc).toMatchObject({ replayed: true, draft_version: 2, current_draft_version: 2 });
  });
});

describe("rejections", () => {
  it("conflicting edits return a conflict with the current version, never an overwrite", async () => {
    const created = await createDraft();
    const id = created.sc.briefing_id;
    const ev = created.sc.evidence_candidates[0].id;
    await mcp.call("update_brief_draft", { briefing_id: id, expected_version: 1, evidence_decisions: [{ evidence_id: ev, status: "approved" }], idempotency_key: key() });
    const r = await mcp.call("update_brief_draft", { briefing_id: id, expected_version: 1, evidence_decisions: [{ evidence_id: ev, status: "excluded" }], idempotency_key: key() });
    expect(r.isError).toBe(true);
    expect(r.sc.error).toMatchObject({ code: "conflict", details: { currentVersion: 2 } });
    const d = await mcp.call("get_brief", { briefing_id: id, view: "draft" });
    expect(d.sc.evidence.find((e: any) => e.id === ev).status).toBe("approved");
  });

  it("a revoked connection is unauthenticated on the next request", async () => {
    await revokeConnection(w.h.db, w.ctx("maya"), { connectionId: mcp.connectionId });
    await expect(mcp.call("get_authoring_context")).rejects.toThrow();
    const res = await handleMcpHttpRequest(
      new Request(MCP_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${mcp.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
      { db: w.h.db, appUrl: APP_URL },
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/^Bearer realm="cerebro"/);
  });

  it("requires a bearer token, and refuses dev tokens in production unless explicitly allowed", async () => {
    const req = (headers: Record<string, string>) =>
      new Request(MCP_URL, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
    const missing = await handleMcpHttpRequest(req({}), { db: w.h.db, appUrl: APP_URL });
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toMatch(/^Bearer realm="cerebro"/);
    const bogus = await handleMcpHttpRequest(req({ authorization: "Bearer cbr_nope" }), { db: w.h.db, appUrl: APP_URL });
    expect(bogus.status).toBe(401);

    const auth = { authorization: `Bearer ${mcp.token}` };
    const prod = await handleMcpHttpRequest(req(auth), { db: w.h.db, appUrl: APP_URL, env: { NODE_ENV: "production" } });
    expect(prod.status).toBe(401);
    expect(await prod.text()).toMatch(/disabled in production/);
    const allowed = await handleMcpHttpRequest(req(auth), {
      db: w.h.db,
      appUrl: APP_URL,
      env: { NODE_ENV: "production", CEREBRO_ALLOW_DEV_CONNECTION_TOKENS: "1" },
    });
    expect(allowed.status).toBe(200);

    const get = await handleMcpHttpRequest(new Request(MCP_URL, { method: "GET", headers: auth }), { db: w.h.db, appUrl: APP_URL });
    expect(get.status).toBe(405);
  });

  it("rejects unauthorized destinations and cross-company ids without creating anything", async () => {
    // A team the user does not belong to.
    const sales = await mcp.call("create_brief_draft", { handoff: platformHandoff({ destination: { label: "Sales team" } }), idempotency_key: key() });
    expect(sales.isError).toBe(true);
    expect(sales.sc.error.code).toBe("forbidden");
    const salesId = await mcp.call("create_brief_draft", {
      handoff: platformHandoff({ destination: { teamId: w.seed.orgs.acme.teams.sales } }),
      idempotency_key: key(),
    });
    expect(salesId.sc.error.code).toBe("forbidden");
    // A Globex team id is unknown inside Acme.
    const globex = await mcp.call("create_brief_draft", {
      handoff: platformHandoff({ destination: { teamId: w.seed.orgs.globex.teams.logistics } }),
      idempotency_key: key(),
    });
    expect(globex.isError).toBe(true);
    expect(globex.sc.error.code).toBe("not_found");
    // A Globex audience id is rejected too.
    const globexAudience = await mcp.call("create_brief_draft", {
      handoff: platformHandoff({ audience: { visibility: "team", teamId: w.seed.orgs.globex.teams.logistics } }),
      idempotency_key: key(),
    });
    expect(globexAudience.isError).toBe(true);
    expect(await listMyDrafts(w.h.db, w.ctx("maya"))).toHaveLength(0);

    // A Globex briefing id is not found through an Acme connection.
    const g = await createBriefing(w.h.db, w.ctx("taylor", "globex"), {
      handoff: platformHandoff({ destination: undefined }),
      audience: { visibility: "company" },
    });
    for (const [tool, args] of [
      ["get_brief", { briefing_id: g.briefingId, view: "draft" }],
      ["preview_brief", { briefing_id: g.briefingId }],
      ["update_brief_draft", { briefing_id: g.briefingId, expected_version: 1, evidence_decisions: [{ evidence_id: "ev_x1234", status: "approved" }], idempotency_key: key() }],
      ["get_author_feedback", { briefing_id: g.briefingId }],
    ] as const) {
      const r = await mcp.call(tool, args);
      expect(r.isError, tool).toBe(true);
      expect(r.sc.error.code, tool).toBe("not_found");
    }
  });

  it("an ambiguous destination asks for clarification and creates nothing", async () => {
    const platform2 = await createTeam(w.h.db, w.ctx("riley"), { departmentId: w.seed.orgs.acme.departments.engineering!, name: "Platform" });
    await addTeamMember(w.h.db, w.ctx("riley"), { teamId: platform2.id, userId: w.seed.users.maya });
    const r = await mcp.call("create_brief_draft", { handoff: platformHandoff({ destination: { label: "Platform" } }), idempotency_key: key() });
    expect(r.isError).toBeFalsy();
    expect(r.sc.status).toBe("needs_clarification");
    expect(r.sc.reason).toBe("ambiguous_destination");
    expect(r.sc.candidates.map((c: any) => c.label).sort()).toEqual(["Acme / Engineering / Platform", "Acme / Product / Platform"]);
    expect(r.text).toContain("No draft was created");
    expect(await listMyDrafts(w.h.db, w.ctx("maya"))).toHaveLength(0);

    // No destination and no remembered default also asks.
    const none = await mcp.call("create_brief_draft", { handoff: platformHandoff({ destination: undefined }), idempotency_key: key() });
    expect(none.sc).toMatchObject({ status: "needs_clarification", reason: "no_default" });
    expect(none.sc.candidates.length).toBeGreaterThan(1);
    expect(await listMyDrafts(w.h.db, w.ctx("maya"))).toHaveLength(0);
  });

  it("returns structured validation issues for a malformed handoff", async () => {
    const r = await mcp.call("create_brief_draft", { handoff: { handoffVersion: 2 }, idempotency_key: key() });
    expect(r.isError).toBe(true);
    expect(r.sc.error.code).toBe("validation");
    expect(r.sc.error.details.issues.length).toBeGreaterThan(0);
  });
});

describe("author feedback", () => {
  it("returns submitted feedback and never private reader Q&A", async () => {
    const created = await createDraft();
    const id = created.sc.briefing_id as string;
    const p = await mcp.call("preview_brief", { briefing_id: id });
    await mcp.call("publish_brief", { briefing_id: id, preview_id: p.sc.preview_id, idempotency_key: key() });
    await drainJobs(w);

    const secret = "PRIVATE-QUESTION: is this a cover for layoffs?";
    await askQuestion(w.h.db, w.ctx("alex"), { briefingId: id, question: secret });
    await submitFeedback(w.h.db, w.ctx("alex"), { briefingId: id, revisionNumber: 1, type: "question", text: "When does the merged roadmap start?" });

    const f = await mcp.call("get_author_feedback", { briefing_id: id });
    expect(f.isError, f.text).toBeFalsy();
    expect(f.sc.feedback.map((x: any) => x.text)).toEqual(["When does the merged roadmap start?"]);
    expect(JSON.stringify(f)).not.toContain("PRIVATE-QUESTION");
    expect(f.text).not.toContain("PRIVATE-QUESTION");

    // Readers cannot pull author feedback.
    const alex = await connect(w, "alex");
    const denied = await alex.call("get_author_feedback", { briefing_id: id });
    expect(denied.isError).toBe(true);
    await alex.close();
  });
});

describe("transport", () => {
  it("a second client with the same token works statelessly", async () => {
    const c = await connectWithToken(w, mcp.token);
    const r = await c.callTool({ name: "get_authoring_context", arguments: {} });
    expect(r.isError).toBeFalsy();
    await c.close();
  });
});
