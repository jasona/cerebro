export interface CaptureLimits {
  /** Maximum upload size in bytes. */
  maxBytes: number;
  /** Maximum pasted/decoded text length in characters for text kinds. */
  maxInputCharacters: number;
  /** Maximum extracted characters kept per source; the rest is reported as truncated. */
  maxCharacters: number;
  maxPages: number;
  maxSlides: number;
  maxMessages: number;
  /** ZIP containers (DOCX/PPTX). */
  maxZipEntries: number;
  /** Sum of declared uncompressed sizes. */
  maxUncompressedBytes: number;
  /** Largest declared uncompressed size of one entry. */
  maxEntryUncompressedBytes: number;
  /** Max uncompressed/compressed ratio, for the archive overall and for any entry above `ratioCheckMinBytes`. */
  maxCompressionRatio: number;
  ratioCheckMinBytes: number;
  /** Chunking. */
  targetChunkCharacters: number;
  maxChunkCharacters: number;
}

/**
 * Default limits. These are engineering defaults for safety, not agreed product
 * targets; callers may tighten them via `ExtractOptions.limits`.
 */
export const CAPTURE_LIMITS: Readonly<CaptureLimits> = Object.freeze({
  maxBytes: 20 * 1024 * 1024,
  maxInputCharacters: 2_000_000,
  maxCharacters: 2_000_000,
  maxPages: 500,
  maxSlides: 300,
  maxMessages: 5_000,
  maxZipEntries: 5_000,
  maxUncompressedBytes: 200 * 1024 * 1024,
  maxEntryUncompressedBytes: 50 * 1024 * 1024,
  maxCompressionRatio: 100,
  ratioCheckMinBytes: 1024 * 1024,
  targetChunkCharacters: 1_200,
  maxChunkCharacters: 1_600,
});

export function resolveLimits(overrides?: Partial<CaptureLimits>): CaptureLimits {
  return { ...CAPTURE_LIMITS, ...(overrides ?? {}) };
}
