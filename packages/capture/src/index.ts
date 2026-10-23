/**
 * @cerebro/capture — text extraction with locators from author sources
 * (pasted text/Markdown/conversations, PDF, DOCX, PPTX).
 *
 * All extracted text is untrusted data and a private authoring resource; see
 * `extractSource` for the safety contract.
 */
export { extractSource, ExtractSourceInputSchema } from "./extract";
export { detectKind } from "./detect";
export { validateUpload, type UploadError, type UploadErrorCode, type UploadValidation, type ValidateUploadInput } from "./validate";
export { CAPTURE_LIMITS, resolveLimits, type CaptureLimits } from "./limits";
export { checkZipSafety, readZipDirectory, checkZipEntries, type ZipEntryInfo, type ZipProblem } from "./zip";
export { chunkSegments, chunkText, locatorLabel, type Segment, type ChunkingOptions } from "./chunk";
export { parseConversation, parseMarker } from "./formats/conversation";
export { checksum, normalizeText } from "./text";
export * from "./types";
