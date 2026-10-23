/** Text fallbacks (T21): structured summaries for hosts without embedded UI. */
import type { AudienceDTO, CreatePreviewResult, DraftEvidenceDTO, HomeDTO } from "@cerebro/domain";

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1).trimEnd()}…`;
};

/** Audience stated explicitly, including the company-wide default. */
export function describeAudience(audience: Pick<AudienceDTO, "visibility" | "label" | "namedReaders">, isDefault = false): string {
  const scope =
    audience.visibility === "company"
      ? `${audience.label} (company-wide${isDefault ? ", the default" : ""})`
      : audience.visibility === "restricted"
        ? audience.label
        : `${audience.label} only`;
  const named = audience.namedReaders ?? [];
  if (named.length === 0) return scope;
  return `${scope}; named readers: ${named.map((r) => r.displayName).join(", ")}`;
}

export const describeHome = (home: Pick<HomeDTO, "label">) => home.label;

export function evidenceLines(evidence: DraftEvidenceDTO[]): string[] {
  if (evidence.length === 0) return ["Evidence: none supplied. The brief would publish with \"No supporting evidence attached\"."];
  return [
    `Evidence candidates (${evidence.length}), none approved on arrival:`,
    ...evidence.map((e) => `  - [${e.id}] ${clip(e.title, 100)}${e.attribution ? ` — ${clip(e.attribution, 80)}` : ""} (${e.status})`),
  ];
}

export const PUBLISH_GUARD =
  "Nothing has been published. Publish only if the user explicitly asks to publish this preview in this conversation, after seeing it; then call publish_brief with this preview_id.";

export function previewText(p: CreatePreviewResult, previewUrl: string, opts: { title: string; audienceIsDefault?: boolean }): string {
  const lines: string[] = [];
  lines.push(`Preview of "${opts.title}" (draft version ${p.draftVersion}). Not published.`);
  lines.push(`Home: ${describeHome(p.home)}`);
  lines.push(`Audience: ${describeAudience(p.audience, opts.audienceIsDefault)}`);
  lines.push(`Sections (${p.includedSections.length}):`);
  for (const s of p.includedSections) lines.push(`  - ${s.title} (${s.blockCount} block${s.blockCount === 1 ? "" : "s"})`);
  if (p.document.perspectives.length) {
    lines.push(`Perspectives: ${p.document.perspectives.map((x) => x.label).join(", ")}`);
  }

  const { approved, candidates, excluded } = p.evidence;
  if (approved.length === 0) {
    lines.push("Evidence: No supporting evidence attached. Readers will see that state.");
  } else {
    lines.push(`Approved evidence that will be published (${approved.length}):`);
    for (const e of approved) lines.push(`  - [${e.id}] ${clip(e.title, 100)}${e.attribution ? ` — ${clip(e.attribution, 80)}` : ""}`);
  }
  if (candidates.length) {
    lines.push(`Candidates awaiting the author's approval, NOT published unless approved (${candidates.length}):`);
    for (const e of candidates) lines.push(`  - [${e.id}] ${clip(e.title, 100)}${e.attribution ? ` — ${clip(e.attribution, 80)}` : ""}: "${clip(e.excerpt, 160)}"`);
    lines.push("  To approve or exclude, the author decides; then call update_brief_draft with evidence_decisions and preview again.");
  }
  if (excluded.length) lines.push(`Excluded by the author, stays private (${excluded.length}): ${excluded.map((e) => e.id).join(", ")}`);

  if (p.droppedRefs.length) {
    lines.push(`Claims publishing without evidence (${p.droppedRefs.length}):`);
    for (const d of p.droppedRefs) lines.push(`  - block ${d.blockId} cites ${d.evidenceId}, which is not approved`);
  }
  const errors = p.issues.filter((i) => i.severity === "error");
  const warnings = p.issues.filter((i) => i.severity !== "error");
  if (errors.length) {
    lines.push(`Errors blocking publication (${errors.length}):`);
    for (const i of errors) lines.push(`  - ${i.message}`);
  }
  if (warnings.length) {
    lines.push(`Content gaps and warnings (${warnings.length}), publishable but visible to the author:`);
    for (const i of warnings) lines.push(`  - ${i.message}`);
  }
  if (!p.issues.length) lines.push("Issues: none.");
  lines.push(`Change summary: ${p.changeSummary.join(" ")}`);
  lines.push(`Preview id: ${p.previewId} (expires ${new Date(p.expiresAt).toISOString()})`);
  lines.push(`Review in Cerebro (sign-in required): ${previewUrl}`);
  lines.push(p.canPublish ? PUBLISH_GUARD : "This preview cannot be published until the errors above are fixed.");
  return lines.join("\n");
}
