import type { ReactNode } from "react";
import type { Block, BriefingDocument, EvidenceItem } from "@cerebro/briefing-schema/client";

export type RenderMode = "reader" | "preview";

/** Interaction hooks supplied by the app. All optional; the renderer has no editor controls. */
export interface RenderOptions {
  mode: RenderMode;
  /** Builds the href for an evidence marker. Default: `#evidence-<id>` (the in-page EvidenceList). */
  evidenceHref?: (evidenceId: string, blockId: string) => string;
  /**
   * Renders markers as buttons calling this. Only usable when the tree is
   * rendered from a client component (functions cannot cross the RSC boundary).
   */
  onEvidenceSelect?: (evidenceId: string, blockId: string) => void;
  /** Extra controls beside a block, e.g. an "Ask about this" button. */
  renderBlockActions?: (block: Block) => ReactNode;
  /** Preview-only notes keyed by block id or section id. */
  annotations?: Record<string, ReactNode>;
}

export interface NumberedEvidence {
  item: EvidenceItem;
  /** 1-based reader-facing number, stable for the document. */
  number: number;
}

export interface RenderContext extends RenderOptions {
  evidence: Map<string, NumberedEvidence>;
}

/**
 * Evidence a given mode may show. Reader mode shows only approved items
 * (published projections have `status` stripped, which counts as approved).
 * Preview also shows candidates so authors see what is pending; excluded items
 * are never shown.
 */
export function visibleEvidence(document: BriefingDocument, mode: RenderMode): EvidenceItem[] {
  return document.evidence.filter((e) => {
    if (e.status === "excluded") return false;
    if (e.status === "candidate") return mode === "preview";
    return true;
  });
}

export function buildContext(document: BriefingDocument, options: RenderOptions): RenderContext {
  const evidence = new Map<string, NumberedEvidence>();
  visibleEvidence(document, options.mode).forEach((item, i) => evidence.set(item.id, { item, number: i + 1 }));
  return { ...options, evidence };
}

export const evidenceAnchorId = (evidenceId: string) => `evidence-${evidenceId}`;
