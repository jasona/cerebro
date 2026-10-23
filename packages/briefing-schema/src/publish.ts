import {
  PublishedBriefingDocument,
  type BriefingDocument,
  type PublishedEvidenceItem,
} from "./document";
import { evidenceStatus } from "./validate";

export interface DroppedRef {
  blockId: string;
  evidenceId: string;
}

export interface PublishedProjection {
  document: PublishedBriefingDocument;
  /** References removed because their evidence is not approved (or missing). Show as "claims publishing without evidence". */
  droppedRefs: DroppedRef[];
  /** Approved evidence included in the revision, in document order, draft-only fields stripped. */
  approvedEvidence: PublishedEvidenceItem[];
}

/**
 * Projects a parsed draft into the sealed revision shape:
 * - keeps only approved evidence (candidate/excluded remain private authoring material);
 * - strips draft-only `status` and `sourceRef`;
 * - removes block `evidenceRefs` that point at non-approved or missing evidence.
 *
 * Pure and idempotent: projecting an already-published document returns an
 * equal document with no dropped refs. Does not mutate its input.
 */
export function toPublishedDocument(draft: BriefingDocument | PublishedBriefingDocument): PublishedProjection {
  const approvedEvidence: PublishedEvidenceItem[] = [];
  const approvedIds = new Set<string>();
  for (const item of draft.evidence) {
    if (evidenceStatus(item) !== "approved") continue;
    const { status: _status, sourceRef: _sourceRef, ...rest } = item as BriefingDocument["evidence"][number];
    approvedEvidence.push(structuredClone(rest));
    approvedIds.add(item.id);
  }

  const droppedRefs: DroppedRef[] = [];
  const sections = draft.sections.map((section) => ({
    ...structuredClone(section),
    blocks: section.blocks.map((block) => {
      const copy = structuredClone(block);
      copy.evidenceRefs = copy.evidenceRefs.filter((ref) => {
        if (approvedIds.has(ref.evidenceId)) return true;
        droppedRefs.push({ blockId: block.id, evidenceId: ref.evidenceId });
        return false;
      });
      return copy;
    }),
  }));

  const document = PublishedBriefingDocument.parse({
    ...structuredClone(draft),
    sections,
    evidence: approvedEvidence,
  });
  return { document, droppedRefs, approvedEvidence: structuredClone(approvedEvidence) };
}

/**
 * Canonical JSON: object keys sorted (by UTF-16 code unit), `undefined`
 * properties omitted, arrays kept in order, no whitespace. Non-finite numbers
 * and non-plain values are rejected so equal documents always serialize
 * identically.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("canonicalJson: non-finite number");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError("canonicalJson: only plain objects are supported");
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record)
        .filter((k) => record[k] !== undefined)
        .sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(",")}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported type ${typeof value}`);
  }
}
