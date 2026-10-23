/**
 * Turning a host-supplied replacement (a full document or a new handoff) into
 * the next draft document, while keeping the author in control of evidence:
 *
 * - Evidence approval is changed only by explicit `evidence_decisions`. A
 *   replacement can never approve evidence by itself: an item keeps its
 *   current status only when its id (document path) or its title + excerpt
 *   (handoff path) matches an existing item with unchanged text; anything new
 *   or edited becomes a `candidate`.
 * - Private `sourceRef`s are never introduced by the host; an existing
 *   matched item keeps its own.
 * - The handoff path preserves section, block, perspective and evidence ids
 *   where the content lines up, so feedback anchors and pinned links stay
 *   meaningful. It replaces content; it does not attempt a semantic merge.
 */
import {
  BriefingDocument,
  handoffToDocument,
  type EvidenceItem,
  type HandoffPackage,
} from "@cerebro/briefing-schema";

type Doc = BriefingDocument;

/** Apply the evidence guard to a host-supplied full document. */
export function guardDocumentEvidence(current: Doc, next: Doc): Doc {
  const byId = new Map(current.evidence.map((e) => [e.id, e]));
  return {
    ...next,
    evidence: next.evidence.map((e) => {
      const prev = byId.get(e.id);
      const { sourceRef: _ignored, ...rest } = e;
      if (prev && prev.title === e.title && prev.excerpt === e.excerpt) {
        return { ...rest, status: prev.status ?? "candidate", ...(prev.sourceRef ? { sourceRef: prev.sourceRef } : {}) };
      }
      return { ...rest, status: "candidate" as const };
    }),
  };
}

const evidenceKey = (e: Pick<EvidenceItem, "title" | "excerpt">) => `${e.title}\u0000${e.excerpt}`;

/**
 * Compose a handoff and align its ids with the current draft. Returns the
 * next document (before validation) and the composer's content gaps.
 */
export function mergeHandoffIntoDraft(current: Doc, handoff: HandoffPackage): { document: Doc; gaps: string[] } {
  const composed = handoffToDocument(handoff);
  const next = BriefingDocument.parse(composed.document);

  // Evidence: match by exact title + excerpt.
  const currentEv = new Map(current.evidence.map((e) => [evidenceKey(e), e]));
  const usedEv = new Set<string>();
  const evMap = new Map<string, string>();
  const evidence = next.evidence.map((e) => {
    const prev = currentEv.get(evidenceKey(e));
    const { sourceRef: _ignored, ...rest } = e;
    if (prev && !usedEv.has(prev.id)) {
      usedEv.add(prev.id);
      evMap.set(e.id, prev.id);
      return { ...rest, id: prev.id, status: prev.status ?? "candidate", ...(prev.sourceRef ? { sourceRef: prev.sourceRef } : {}) };
    }
    return { ...rest, status: "candidate" as const };
  });

  // Sections by title; blocks by position and type inside a matched section.
  const currentSections = new Map(current.sections.map((s) => [s.title.trim().toLowerCase(), s]));
  const usedSec = new Set<string>();
  const secMap = new Map<string, string>();
  const blockMap = new Map<string, string>();
  const takenIds = new Set<string>();
  const sections = next.sections.map((s) => {
    const prev = currentSections.get(s.title.trim().toLowerCase());
    if (!prev || usedSec.has(prev.id)) return s;
    usedSec.add(prev.id);
    secMap.set(s.id, prev.id);
    const blocks = s.blocks.map((b, i) => {
      const pb = prev.blocks[i];
      if (pb && pb.type === b.type && !takenIds.has(pb.id)) {
        takenIds.add(pb.id);
        blockMap.set(b.id, pb.id);
        return { ...b, id: pb.id };
      }
      return b;
    });
    return { ...s, id: prev.id, blocks };
  });
  const remapRefs = <T extends { evidenceRefs: { evidenceId: string; note?: string }[] }>(b: T): T => ({
    ...b,
    evidenceRefs: b.evidenceRefs.map((r) => ({ ...r, evidenceId: evMap.get(r.evidenceId) ?? r.evidenceId })),
  });

  // Perspectives by label.
  const currentPsp = new Map(current.perspectives.map((p) => [p.label.trim().toLowerCase(), p]));
  const perspectives = next.perspectives.map((p) => {
    const prev = currentPsp.get(p.label.trim().toLowerCase());
    return {
      ...p,
      ...(prev ? { id: prev.id } : {}),
      emphasis: p.emphasis.map((id) => secMap.get(id) ?? id),
      implications: p.implications.map((im) => ({ ...im, blockIds: im.blockIds.map((id) => blockMap.get(id) ?? id) })),
    };
  });

  return {
    document: {
      ...next,
      sections: sections.map((s) => ({ ...s, blocks: s.blocks.map(remapRefs) })),
      perspectives,
      evidence,
    },
    gaps: composed.gaps,
  };
}
