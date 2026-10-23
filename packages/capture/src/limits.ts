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
  /** Images: largest decoded size accepted at upload (width × height), checked from the header before decoding. */
  maxImagePixels: number;
  /** Images: largest width or height accepted at upload. */
  maxImageDimension: number;
  /** OCR: images and rendered PDF pages are scaled down to at most this many pixels before recognition. */
  maxOcrPixels: number;
  /** OCR: most PDF pages read by OCR per source; later scanned pages are reported as gaps. */
  maxOcrPages: number;
  /** OCR: resolution PDF pages are rendered at (reduced to fit `maxOcrPixels`). */
  ocrRenderDpi: number;
  /** OCR: a PDF page that cannot be rendered at this resolution within `maxOcrPixels` is not OCR-read. */
  minOcrRenderDpi: number;
  /** OCR: a PDF page whose text layer has fewer non-space characters than this is OCR-read. */
  minTextLayerCharacters: number;
  /** OCR: lines with recogniser confidence (0–100) below this are left out and reported as a gap. */
  minOcrLineConfidence: number;
  /** OCR: time allowed for one page or image. */
  ocrPageTimeoutMs: number;
  /** OCR: time allowed for all OCR in one source (well inside the job claim's stale timeout). */
  ocrTotalTimeoutMs: number;
}

/**
 * Default limits. These are engineering defaults for safety (provisional
 * implementation settings), not agreed product targets; callers may tighten
 * them via `ExtractOptions.limits`.
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
  maxImagePixels: 50_000_000,
  maxImageDimension: 20_000,
  maxOcrPixels: 16_000_000,
  maxOcrPages: 50,
  ocrRenderDpi: 200,
  minOcrRenderDpi: 100,
  minTextLayerCharacters: 20,
  minOcrLineConfidence: 60,
  ocrPageTimeoutMs: 60_000,
  ocrTotalTimeoutMs: 240_000,
});

export function resolveLimits(overrides?: Partial<CaptureLimits>): CaptureLimits {
  return { ...CAPTURE_LIMITS, ...(overrides ?? {}) };
}
