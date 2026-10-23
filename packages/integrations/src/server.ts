/**
 * Cerebro's remote MCP adapter: "Send this to Cerebro" from an executive's
 * LLM (LLM_INTEGRATION.md, "Proposed tool surface"). Every tool calls the
 * same domain services as the web app; authorization stays in the domain.
 *
 * Rules carried here:
 * - Identity and company come only from the authenticated `ctx`, never from
 *   tool arguments. A connection is bound to one company, so destinations
 *   and ids are always resolved inside it (never guessed across companies).
 * - Drafts are private. Publication requires a reviewed preview and an
 *   explicit request from the human; the domain enforces the preview binding.
 * - Every mutation runs through `runIdempotent` with the domain `*InTx`
 *   variant inside the same transaction, so the operation record and the
 *   change commit atomically.
 * - Nothing here logs handoff content, prompts, document bodies or tokens.
 */
import {
  briefingDocumentJsonSchema,
  type BriefingDocument,
  handoffJsonSchema,
  handoffToDocument,
  parseDocument,
  parseHandoff,
  type DocumentIssue,
  type HandoffPackage,
} from "@cerebro/briefing-schema";
import type { Database } from "@cerebro/database";
import {
  createBriefingInTx,
  createLogger,
  createPreview,
  DomainError,
  enforceRateLimit,
  getAuthorFeedback,
  getAuthoringContext,
  getBriefingMeta,
  getDraft,
  getDraftInTx,
  getOperation,
  getRevisionDocument,
  listMyDrafts,
  publishBriefingInTx,
  resolveAudienceInTx,
  resolveDestinationInTx,
  runIdempotent,
  searchBriefings,
  updateDraftInTx,
  type DestinationHome,
  type DraftPatchOp,
  type RequestContext,
} from "@cerebro/domain";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { describeAudience, evidenceLines, previewText } from "./format";
import { guardDocumentEvidence, mergeHandoffIntoDraft } from "./merge";
import { fail, ok, toToolError } from "./results";
import { TOOL_SCOPES, type McpScope, type McpToolName } from "./scopes";

const logger = createLogger({ component: "mcp" });

export interface CerebroMcpServerOptions {
  db: Database;
  /** Server-resolved context for the authenticated connection (`via: "mcp"`). */
  ctx: RequestContext;
  /** Canonical base URL of the Cerebro web app, without a trailing slash. */
  appUrl: string;
  /** Scopes granted to this connection (`./scopes`); each tool requires one. */
  scopes: ReadonlySet<McpScope>;
}

export const SERVER_INSTRUCTIONS = [
  "Cerebro turns the executive's selected thinking into an evidence-backed briefing for colleagues.",
  "Workflow: get_authoring_context → create_brief_draft (private draft) → preview_brief → (author approves/excludes evidence via update_brief_draft, then preview again) → publish_brief only when the human explicitly asks to publish.",
  "Send only the content the user selected. Never invent evidence, quotes, numbers, owners or dates; leave gaps as gaps.",
  "If a tool returns needs_clarification, ask the user the question and retry with their answer. Never guess a destination or audience.",
  "Credentials are never passed in tool arguments or the conversation.",
].join("\n");

const stripSchemaKey = (s: Record<string, unknown>) => {
  const { $schema: _ignored, ...rest } = s;
  return rest;
};

/*
 * Large structured inputs (handoff, document) are accepted as plain objects at
 * the MCP layer and validated by the briefing schema in the handler, so a
 * malformed package returns a structured `validation` error with JSON paths
 * instead of a protocol error. `.meta()` publishes the real JSON Schema to the
 * host in tools/list.
 */
const HandoffArg = z
  .record(z.string(), z.unknown())
  .meta({ ...stripSchemaKey(handoffJsonSchema()), description: "Versioned handoff package (handoffVersion: 1) with only the content the user selected." });
const DocumentArg = z
  .record(z.string(), z.unknown())
  .meta({ ...stripSchemaKey(briefingDocumentJsonSchema()), description: "A complete briefing document (schemaVersion 1) replacing the draft content." });
const IdempotencyKey = z
  .string()
  .min(8)
  .max(200)
  .describe("Client-generated unique key for this mutation (e.g. a UUID). Reuse it only to retry the identical request after a timeout.");
const BriefingId = z.string().uuid().describe("Briefing id returned by Cerebro.");

const NO_ARGS = {};

class NeedsClarification extends Error {
  constructor(
    readonly reason: string,
    readonly question: string,
    readonly candidates: DestinationHome[] = [],
    readonly extra: Record<string, unknown> = {},
  ) {
    super("needs_clarification");
  }
}

const homeSummary = (h: DestinationHome) => ({
  kind: h.kind,
  label: h.label,
  department_id: h.departmentId,
  team_id: h.teamId,
});

function splitIssues(issues: DocumentIssue[]) {
  return {
    errors: issues.filter((i) => i.severity === "error"),
    warnings: issues.filter((i) => i.severity !== "error"),
  };
}

export function createCerebroMcpServer({ db, ctx, appUrl, scopes }: CerebroMcpServerOptions): McpServer {
  const base = appUrl.replace(/\/+$/, "");
  const server = new McpServer({ name: "cerebro", version: "0.1.0" }, { instructions: SERVER_INSTRUCTIONS });

  const urls = (canonicalPath: string) => ({
    canonical_url: `${base}${canonicalPath}`,
    preview_url: `${base}${canonicalPath}/preview`,
    edit_url: `${base}${canonicalPath}/edit`,
  });

  // Run a tool handler: require the tool's scope (defense in depth; the HTTP
  // layer already answered 403 insufficient_scope), then map thrown errors to
  // tool errors. Resource permissions are still checked by the domain.
  const run = async <T>(tool: McpToolName, fn: () => Promise<T>) => {
    const scope = TOOL_SCOPES[tool];
    if (!scopes.has(scope)) {
      return fail("forbidden", `This connection is not authorized for ${scope}.`, { reason: "insufficient_scope", scope }, "Ask the user to reconnect Cerebro and grant this permission.");
    }
    try {
      return await fn();
    } catch (e) {
      return toToolError(e);
    }
  };

  /*
   * Every tool goes through this wrapper: per-user and per-connection rate
   * limits (off unless configured) are enforced before the handler runs, and
   * one structured log line records the tool name, outcome code and latency.
   * Arguments and results are never logged.
   */
  const log = logger.child({ requestId: ctx.requestId, organizationId: ctx.organizationId, userId: ctx.userId, connectionId: ctx.connectionId ?? null });
  const registerTool = ((name: string, config: unknown, handler: (...args: unknown[]) => Promise<CallToolResult>) =>
    (server.registerTool.bind(server) as (n: string, c: unknown, h: (...args: unknown[]) => Promise<CallToolResult>) => unknown)(
      name,
      config,
      async (...args: unknown[]) => {
        const started = performance.now();
        let result: CallToolResult;
        try {
          await enforceRateLimit(db, ctx, "mcp_tool");
          result = await handler(...args);
        } catch (e) {
          result = toToolError(e);
        }
        const code = result.isError ? ((result.structuredContent as { error?: { code?: string } } | undefined)?.error?.code ?? "error") : "ok";
        log[result.isError && code === "unavailable" ? "error" : "info"]("mcp.tool_call", {
          tool: name,
          outcome: result.isError ? "error" : "ok",
          code,
          latencyMs: Math.round(performance.now() - started),
        });
        return result;
      },
    )) as unknown as typeof server.registerTool;

  // -------------------------------------------------------------------------
  registerTool(
    "get_authoring_context",
    {
      title: "Get Cerebro authoring context",
      description:
        "Return the connected company, the destinations (company, departments, teams) this user may publish into, remembered preferences, default visibility and capabilities. Call this before creating a brief.",
      inputSchema: NO_ARGS,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () =>
      run("get_authoring_context", async () => {
        const ac = await getAuthoringContext(db, ctx);
        const all = [ac.destinations.company, ...ac.destinations.departments, ...ac.destinations.teams];
        const text = [
          `Connected to ${ac.company.name} as ${ac.user.displayName} (${ac.user.role}). This connection is bound to this company only.`,
          `Destinations you may publish into: ${all.map((d) => d.label).join("; ")}.`,
          `Remembered default home: ${ac.preferences.defaultHome?.label ?? "none"}.`,
          `Default audience when none is requested: everyone at ${ac.company.name} (shown in every preview).`,
        ].join("\n");
        return ok(text, {
          company: ac.company,
          user: ac.user,
          destinations: {
            company: homeSummary(ac.destinations.company),
            departments: ac.destinations.departments.map(homeSummary),
            teams: ac.destinations.teams.map(homeSummary),
          },
          preferences: {
            default_home: ac.preferences.defaultHome ? homeSummary(ac.preferences.defaultHome) : null,
            default_department: ac.preferences.defaultDepartment,
            default_team: ac.preferences.defaultTeam,
            preferred_style: ac.preferences.preferredStyle,
          },
          visibility_options: ac.visibilityOptions,
          default_visibility: ac.defaultVisibility,
          capabilities: ac.capabilities,
          handoff_version: 1,
        });
      }),
  );

  // -------------------------------------------------------------------------
  registerTool(
    "create_brief_draft",
    {
      title: "Create a private Cerebro brief draft",
      description: [
        "Create a PRIVATE draft briefing from the content the user selected. Nothing is published or shared with the audience.",
        "Put the requested home in handoff.destination (e.g. { label: \"Platform team\" }) and the requested audience in handoff.audience; Cerebro resolves both server-side. If no audience is given, the proposed audience is the whole company, and every preview states it.",
        "Evidence excerpts arrive as unapproved candidates. If the result is needs_clarification, ask the user and retry; nothing was created.",
      ].join(" "),
      inputSchema: { handoff: HandoffArg, idempotency_key: IdempotencyKey },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ handoff, idempotency_key }) =>
      run("create_brief_draft", async () => {
        const parsed = parseHandoff(handoff);
        if (!parsed.ok) return fail("validation", "The handoff package is invalid.", { issues: parsed.issues });
        const h = parsed.handoff;
        if (h.target) return fail("validation", "This handoff targets an existing briefing. Use update_brief_draft for updates.");
        if (h.audience?.userIds?.length) {
          return fail("validation", "Name individual readers by email (audience.emails); user ids from the host are not accepted.");
        }

        let op;
        try {
          op = await runIdempotent(db, ctx, { action: "create_brief_draft", idempotencyKey: idempotency_key, input: handoff }, async (tx) => {
            const dest = await resolveDestinationInTx(tx, ctx, {
              ...(h.destination?.label ? { text: h.destination.label } : {}),
              ...(h.destination?.departmentId ? { departmentId: h.destination.departmentId } : {}),
              ...(h.destination?.teamId ? { teamId: h.destination.teamId } : {}),
            });
            if (dest.status === "ambiguous") {
              throw new NeedsClarification("ambiguous_destination", "Which of these should be the brief's home?", dest.candidates);
            }
            if (dest.status === "none") {
              if (dest.reason === "no_default" || dest.reason === "no_match") {
                throw new NeedsClarification(dest.reason, dest.message);
              }
              throw new DomainError(dest.reason === "not_authorized" ? "forbidden" : "not_found", dest.message, { reason: dest.reason });
            }
            const home = dest.home;
            const req = h.audience ?? { visibility: "company" as const };
            const aud = await resolveAudienceInTx(tx, ctx, {
              visibility: req.visibility,
              departmentId: req.departmentId ?? (req.visibility === "department" ? home.departmentId : null),
              teamId: req.teamId ?? (req.visibility === "team" ? home.teamId : null),
              readerEmails: req.emails ?? [],
            });
            // Named readers on a new draft must be company members (D10);
            // anyone else is invited from the Access page instead.
            const notNameable = [...aud.invitations.map((i) => i.email), ...aud.readers.filter((r) => !r.isMember).map((r) => r.email)];
            if (notNameable.length) {
              throw new NeedsClarification(
                "unknown_readers",
                "These readers are not company members you can name here. Remove them, or invite them from Cerebro's Access page after creating the draft.",
                [],
                { emails: notNameable },
              );
            }
            const r = await createBriefingInTx(tx, ctx, {
              handoff,
              home: { departmentId: home.departmentId, teamId: home.teamId },
              audience: aud.audience,
            });
            return {
              resultRef: { type: "briefing", id: r.briefingId },
              result: { briefingId: r.briefingId, slug: r.slug, draftVersion: r.draftVersion, audienceDefaulted: !h.audience },
            };
          });
        } catch (e) {
          if (!(e instanceof NeedsClarification)) throw e;
          const candidates = e.candidates.length ? e.candidates : await allDestinations();
          const text = [
            `Needs clarification (${e.reason}): ${e.question}`,
            ...candidates.map((c) => `  - ${c.label}`),
            ...(Array.isArray(e.extra.emails) ? (e.extra.emails as string[]).map((m) => `  - ${m}`) : []),
            "No draft was created. Ask the user, then retry with their answer.",
          ].join("\n");
          return ok(text, {
            status: "needs_clarification",
            reason: e.reason,
            question: e.question,
            candidates: candidates.map(homeSummary),
            ...e.extra,
          });
        }

        const created = op.result as { briefingId: string; draftVersion: number; audienceDefaulted: boolean };
        const [draft, meta] = await Promise.all([getDraft(db, ctx, created.briefingId), getBriefingMeta(db, ctx, created.briefingId)]);
        const gaps = handoffToDocument(h).gaps;
        const { errors, warnings } = splitIssues(draft.issues);
        const audienceText = describeAudience(meta.audience, created.audienceDefaulted);
        const text = [
          `${op.replayed ? "Already created (retry): " : "Created "}private draft "${draft.document.title}" (draft version ${draft.lockVersion}). Not published; only collaborators can see it.`,
          `Home: ${meta.home.label}`,
          `Proposed audience: ${audienceText}`,
          ...evidenceLines(draft.evidence),
          ...(gaps.length ? [`Content gaps (${gaps.length}), left as gaps:`, ...gaps.map((g) => `  - ${g}`)] : []),
          ...(errors.length ? [`Validation errors (${errors.length}):`, ...errors.map((i) => `  - ${i.message}`)] : []),
          "Next: call preview_brief to review exactly what would be published.",
        ].join("\n");
        return ok(text, {
          status: "draft",
          replayed: op.replayed,
          operation_id: op.operationId,
          briefing_id: draft.briefingId,
          slug: draft.slug,
          draft_version: draft.lockVersion,
          home: meta.home,
          audience: { visibility: meta.audience.visibility, label: meta.audience.label, defaulted: created.audienceDefaulted },
          validation_issues: errors,
          warnings,
          gaps,
          evidence_candidates: draft.evidence,
          ...urls(meta.canonicalPath),
        });
      }),
  );

  async function allDestinations(): Promise<DestinationHome[]> {
    const ac = await getAuthoringContext(db, ctx);
    return [ac.destinations.company, ...ac.destinations.departments, ...ac.destinations.teams];
  }

  // -------------------------------------------------------------------------
  registerTool(
    "get_operation",
    {
      title: "Get a Cerebro operation",
      description: "Return the current status and minimal result of one of your earlier Cerebro operations (by operation_id).",
      inputSchema: { operation_id: z.string().uuid() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ operation_id }) =>
      run("get_operation", async () => {
        const o = await getOperation(db, ctx, operation_id);
        return ok(`Operation ${o.id} (${o.action}): ${o.status}.`, {
          operation_id: o.id,
          action: o.action,
          status: o.status,
          result_ref: o.resultRef,
          result: o.result,
          error_category: o.errorCategory,
          created_at: o.createdAt,
          completed_at: o.completedAt,
        });
      }),
  );

  // -------------------------------------------------------------------------
  registerTool(
    "find_briefs",
    {
      title: "Find Cerebro briefs",
      description:
        "Search published briefs the user can read (titles, positions, authors, homes) and, optionally, the user's own drafts by title. Use it to identify the right brief before updating one.",
      inputSchema: {
        query: z.string().trim().min(1).max(200),
        limit: z.number().int().min(1).max(50).optional(),
        include_drafts: z.boolean().optional().describe("Also match the user's own drafts by title (default true)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ query, limit, include_drafts }) =>
      run("find_briefs", async () => {
        const res = await searchBriefings(db, ctx, { q: query, limit: limit ?? 20 });
        const q = query.toLowerCase();
        const drafts = include_drafts === false ? [] : (await listMyDrafts(db, ctx)).filter((d) => d.title.toLowerCase().includes(q));
        const slug = res.items.length ? await companySlug() : "";
        const published = res.items.map((r) => ({
          briefing_id: r.briefingId,
          title: r.title,
          headline: r.headline,
          author: r.author.name,
          home: [r.home.department?.name, r.home.team?.name].filter(Boolean).join(" / ") || "Company",
          audience: r.visibilityLabel,
          revision_number: r.revisionNumber,
          updated_at: r.updatedAt,
          url: `${base}/c/${slug}/b/${r.slug}`,
        }));
        const myDrafts = drafts.map((d) => ({
          briefing_id: d.briefingId,
          title: d.title,
          draft_version: d.lockVersion,
          current_revision_number: d.currentRevisionNumber,
          updated_at: d.draftUpdatedAt,
        }));
        const text = [
          `${res.total} published brief(s) match "${query}"${published.length < res.total ? ` (showing ${published.length})` : ""}.`,
          ...published.map((p) => `  - ${p.title} [${p.briefing_id}] — ${p.home}, ${p.audience}, revision ${p.revision_number}`),
          ...(myDrafts.length ? [`Your drafts (${myDrafts.length}):`, ...myDrafts.map((d) => `  - ${d.title} [${d.briefing_id}] draft v${d.draft_version}`)] : []),
        ].join("\n");
        return ok(text, { total: res.total, briefs: published, drafts: myDrafts });
      }),
  );

  let slugCache: string | undefined;
  async function companySlug(): Promise<string> {
    if (!slugCache) slugCache = (await getAuthoringContext(db, ctx)).company.slug;
    return slugCache;
  }

  // -------------------------------------------------------------------------
  registerTool(
    "get_brief",
    {
      title: "Get a Cerebro brief",
      description:
        "Return a brief with its version identity: the published revision readers see (view \"published\", optionally a pinned revision_number), or the editable draft (view \"draft\", collaborators only) with its draft_version for update_brief_draft.",
      inputSchema: {
        briefing_id: BriefingId,
        view: z.enum(["published", "draft"]).optional().describe("Default \"published\"."),
        revision_number: z.number().int().min(1).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ briefing_id, view, revision_number }) =>
      run("get_brief", async () => {
        const meta = await getBriefingMeta(db, ctx, briefing_id);
        const common = {
          briefing_id,
          title: meta.title,
          home: meta.home,
          audience: { visibility: meta.audience.visibility, label: meta.audience.label },
          capabilities: meta.capabilities,
          current_revision_number: meta.currentPublication?.revisionNumber ?? null,
          ...urls(meta.canonicalPath),
        };
        if (view === "draft") {
          const d = await getDraft(db, ctx, briefing_id);
          const text = [
            `Draft of "${d.document.title}" (draft version ${d.lockVersion}; current publication: ${meta.currentPublication ? `revision ${meta.currentPublication.revisionNumber}` : "none"}).`,
            `Home: ${meta.home.label}. Audience: ${describeAudience(meta.audience)}.`,
            ...evidenceLines(d.evidence),
            "The full draft document is in structuredContent.document.",
          ].join("\n");
          return ok(text, { ...common, view: "draft", draft_version: d.lockVersion, document: d.document, evidence: d.evidence, issues: d.issues });
        }
        const r = await getRevisionDocument(db, ctx, { briefingId: briefing_id, ...(revision_number ? { revisionNumber: revision_number } : {}) });
        const text = [
          `"${r.title}", published revision ${r.revision.revisionNumber}${r.revision.isCurrent ? " (current)" : ""}, ${new Date(r.revision.publishedAt).toISOString()}.`,
          `Position: ${r.document.position.headline}`,
          `Home: ${meta.home.label}. Audience: ${describeAudience(meta.audience)}.`,
          r.noEvidence ? "Evidence: No supporting evidence attached." : `Approved evidence: ${r.evidence.length} item(s).`,
          `Link: ${base}${r.pinnedPath}`,
        ].join("\n");
        return ok(text, {
          ...common,
          view: "published",
          revision: r.revision,
          document: r.document,
          evidence: r.evidence,
          no_supporting_evidence: r.noEvidence,
          pinned_url: `${base}${r.pinnedPath}`,
          draft_version: meta.draft?.lockVersion ?? null,
        });
      }),
  );

  // -------------------------------------------------------------------------
  registerTool(
    "update_brief_draft",
    {
      title: "Update a Cerebro brief draft",
      description: [
        "Apply changes to a brief's private draft against expected_version (from create_brief_draft, get_brief view \"draft\", or an earlier update). On a version mismatch it returns a conflict and overwrites nothing.",
        "Provide at most one of `document` (full replacement) or `handoff` (recomposed from a new handoff; ids preserved where content lines up), and/or `evidence_decisions` to approve or exclude evidence candidates exactly as the author decided.",
        "Replacements never approve evidence by themselves. Home and audience are not changed by this tool. Earlier previews become stale; preview again before publishing.",
      ].join(" "),
      inputSchema: {
        briefing_id: BriefingId,
        expected_version: z.number().int().min(1),
        document: DocumentArg.optional(),
        handoff: HandoffArg.optional(),
        evidence_decisions: z
          .array(z.object({ evidence_id: z.string().min(1).max(80), status: z.enum(["approved", "excluded", "candidate"]) }))
          .max(200)
          .optional()
          .describe("The author's explicit evidence decisions. Only record what the author decided."),
        idempotency_key: IdempotencyKey,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args) =>
      run("update_brief_draft", async () => {
        const { briefing_id, expected_version, document, handoff, evidence_decisions, idempotency_key } = args;
        if (document && handoff) return fail("validation", "Provide either document or handoff, not both.");
        if (!document && !handoff && !evidence_decisions?.length) {
          return fail("validation", "Nothing to change: provide document, handoff or evidence_decisions.");
        }
        let parsedHandoff: HandoffPackage | undefined;
        if (handoff) {
          const p = parseHandoff(handoff);
          if (!p.ok) return fail("validation", "The handoff package is invalid.", { issues: p.issues });
          parsedHandoff = p.handoff;
          const t = p.handoff.target;
          if (t && (t.briefingId !== briefing_id || t.expectedDraftVersion !== expected_version)) {
            return fail("validation", "handoff.target does not match briefing_id and expected_version.");
          }
        }
        let parsedDocument: BriefingDocument | undefined;
        if (document) {
          const p = parseDocument(document);
          if (!p.ok) return fail("validation", "The briefing document is invalid.", { issues: p.issues });
          parsedDocument = p.document;
        }
        const ignored = parsedHandoff && (parsedHandoff.destination || parsedHandoff.audience) ? ["destination", "audience"] : [];

        let gaps: string[] = [];
        const op = await runIdempotent(
          db,
          ctx,
          {
            action: "update_brief_draft",
            idempotencyKey: idempotency_key,
            input: { briefing_id, expected_version, document: document ?? null, handoff: handoff ?? null, evidence_decisions: evidence_decisions ?? [] },
          },
          async (tx) => {
            const current = await getDraftInTx(tx, ctx, briefing_id);
            if (current.lockVersion !== expected_version) {
              throw new DomainError("conflict", "The draft has changed since you loaded it.", { currentVersion: current.lockVersion });
            }
            const patch: DraftPatchOp[] = [];
            if (parsedDocument) patch.push({ op: "replace_document", document: guardDocumentEvidence(current.document, parsedDocument) });
            if (parsedHandoff) {
              const merged = mergeHandoffIntoDraft(current.document, parsedHandoff);
              gaps = merged.gaps;
              patch.push({ op: "replace_document", document: merged.document });
            }
            for (const d of evidence_decisions ?? []) patch.push({ op: "set_evidence_status", evidenceId: d.evidence_id, status: d.status });
            const r = await updateDraftInTx(tx, ctx, { briefingId: briefing_id, expectedVersion: expected_version, patch });
            return { resultRef: { type: "briefing", id: briefing_id }, result: { briefingId: briefing_id, draftVersion: r.draftVersion } };
          },
        );
        if (op.replayed && parsedHandoff) gaps = handoffToDocument(parsedHandoff).gaps;
        const draft = await getDraft(db, ctx, briefing_id);
        const { errors, warnings } = splitIssues(draft.issues);
        const draftVersion = (op.result as { draftVersion: number }).draftVersion;
        const text = [
          `${op.replayed ? "Already applied (retry): " : "Updated "}draft "${draft.document.title}" to draft version ${draftVersion}. Not published.`,
          ...evidenceLines(draft.evidence).map((l) => l.replace(", none approved on arrival", "")),
          ...(gaps.length ? [`Content gaps (${gaps.length}):`, ...gaps.map((g) => `  - ${g}`)] : []),
          ...(errors.length ? [`Validation errors (${errors.length}):`, ...errors.map((i) => `  - ${i.message}`)] : []),
          ...(ignored.length ? ["Note: handoff destination/audience were not applied; change home or audience in Cerebro."] : []),
          "Earlier previews are now stale. Call preview_brief before publishing.",
        ].join("\n");
        return ok(text, {
          status: "draft",
          replayed: op.replayed,
          operation_id: op.operationId,
          briefing_id,
          draft_version: draftVersion,
          current_draft_version: draft.lockVersion,
          validation_issues: errors,
          warnings,
          gaps,
          evidence: draft.evidence,
          ignored_fields: ignored,
        });
      }),
  );

  // -------------------------------------------------------------------------
  registerTool(
    "preview_brief",
    {
      title: "Preview a Cerebro brief before publishing",
      description:
        "Prepare an expiring preview of exactly what would be published: title, home, audience (always stated), sections, perspectives, every evidence candidate and its approval state, claims publishing without evidence, issues and the change summary. Show the preview to the user. It does not publish.",
      inputSchema: {
        briefing_id: BriefingId,
        expected_version: z.number().int().min(1).optional().describe("Fail with a conflict if the draft is no longer at this version."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ briefing_id, expected_version }) =>
      run("preview_brief", async () => {
        const p = await createPreview(db, ctx, { briefingId: briefing_id, ...(expected_version ? { expectedVersion: expected_version } : {}) });
        const meta = await getBriefingMeta(db, ctx, briefing_id);
        const u = urls(meta.canonicalPath);
        const { errors, warnings } = splitIssues(p.issues);
        return ok(previewText(p, u.preview_url, { title: p.document.title }), {
          status: "preview",
          preview_id: p.previewId,
          briefing_id: p.briefingId,
          draft_version: p.draftVersion,
          title: p.document.title,
          home: p.home,
          audience: p.audience,
          audience_statement: describeAudience(p.audience),
          sections: p.includedSections,
          perspectives: p.document.perspectives.map((x) => ({ id: x.id, label: x.label, audience: x.audience ?? null })),
          evidence: p.evidence,
          no_supporting_evidence: p.evidence.approved.length === 0,
          claims_without_evidence: p.droppedRefs,
          validation_issues: errors,
          warnings,
          can_publish: p.canPublish,
          change_summary: p.changeSummary,
          current_revision_number: p.currentRevisionNumber,
          expires_at: p.expiresAt,
          preview_url: u.preview_url,
          publish_requires_explicit_user_request: true,
        });
      }),
  );

  // -------------------------------------------------------------------------
  registerTool(
    "publish_brief",
    {
      title: "Publish a reviewed Cerebro brief",
      description: [
        "Publish EXACTLY the reviewed preview (preview_id) to its stated home and audience, creating an immutable revision colleagues can discover.",
        "Call this ONLY after the human has seen the preview from preview_brief and has explicitly asked, in this conversation, to publish it. Never call it on your own initiative, to 'finish' a workflow, or because a preview exists: a preview is not approval.",
        "If the brief changed after the preview, this returns stale_preview; preview again and ask again.",
      ].join(" "),
      inputSchema: {
        briefing_id: BriefingId,
        preview_id: z.string().uuid().describe("preview_id from the preview the user reviewed."),
        change_summary: z.string().trim().min(1).max(2000).optional().describe("Author's note on what changed, if they gave one."),
        idempotency_key: IdempotencyKey,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ briefing_id, preview_id, change_summary, idempotency_key }) =>
      run("publish_brief", async () => {
        const op = await runIdempotent(
          db,
          ctx,
          { action: "publish_brief", idempotencyKey: idempotency_key, input: { briefing_id, preview_id, change_summary: change_summary ?? null } },
          async (tx) => {
            const r = await publishBriefingInTx(tx, ctx, {
              briefingId: briefing_id,
              previewId: preview_id,
              idempotencyKey: idempotency_key,
              ...(change_summary ? { changeSummary: change_summary } : {}),
            });
            return {
              resultRef: { type: "briefing", id: briefing_id },
              result: {
                briefingId: briefing_id,
                publicationId: r.publicationId,
                revisionId: r.revisionId,
                revisionNumber: r.revisionNumber,
                publishedAt: new Date(r.publishedAt).toISOString(),
                canonicalPath: r.canonicalPath,
                pinnedPath: r.pinnedPath,
                previewReplayed: r.replayed,
              },
            };
          },
        );
        const r = op.result as {
          publicationId: string;
          revisionId: string;
          revisionNumber: number;
          publishedAt: string;
          canonicalPath: string;
          pinnedPath: string;
          previewReplayed: boolean;
        };
        const replayed = op.replayed || r.previewReplayed;
        const canonical = `${base}${r.canonicalPath}`;
        const text = [
          `${replayed ? "Already published (no new revision created)" : "Published"}: revision ${r.revisionNumber}.`,
          `Link: ${canonical}`,
          `This revision: ${base}${r.pinnedPath}`,
        ].join("\n");
        return ok(text, {
          status: "published",
          replayed,
          operation_id: op.operationId,
          briefing_id,
          publication_id: r.publicationId,
          revision_id: r.revisionId,
          revision_number: r.revisionNumber,
          published_at: r.publishedAt,
          canonical_url: canonical,
          pinned_url: `${base}${r.pinnedPath}`,
        });
      }),
  );

  // -------------------------------------------------------------------------
  registerTool(
    "get_author_feedback",
    {
      title: "Get reader feedback for your brief",
      description:
        "Return feedback readers explicitly submitted on a brief, and permitted aggregate topics. Never returns private reader Q&A. Use it to draft a clarification the author can review.",
      inputSchema: { briefing_id: BriefingId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ briefing_id }) =>
      run("get_author_feedback", async () => {
        const f = await getAuthorFeedback(db, ctx, { briefingId: briefing_id });
        const text = [
          `${f.feedback.length} submitted feedback item(s); ${f.topics.length} aggregate topic(s).`,
          ...f.feedback.map((x) => `  - [${x.type}, revision ${x.revisionNumber}, ${x.status}] ${x.submittedBy.displayName}: ${x.text.slice(0, 300)}`),
          ...f.topics.map((t) => `  - Topic (generated summary${t.revisionNumber ? `, revision ${t.revisionNumber}` : ""}): ${t.topic} — ${t.questionCount} question(s) from ${t.readerCount} reader(s)`),
          f.disclosure,
        ].join("\n");
        return ok(text, {
          briefing_id,
          feedback: f.feedback,
          topics: f.topics,
          // Null below the cohort threshold (D07): the count itself is suppressed.
          suppressed_question_count: f.suppressedQuestionCount,
          suppressed_question_count_suppressed: f.suppressedQuestionCountSuppressed,
          disclosure: f.disclosure,
        });
      }),
  );

  return server;
}
