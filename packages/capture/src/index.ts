/**
 * @cerebro/capture — text extraction with locators from author sources
 * (pasted text/Markdown/conversations, PDF, DOCX, PPTX, and images or scanned PDF
 * pages read by local OCR).
 *
 * All extracted text is untrusted data and a private authoring resource; see
 * `extractSource` for the safety contract.
 */
export { extractSource, ExtractSourceInputSchema } from "./extract";
export { detectKind } from "./detect";
export { validateUpload, type UploadError, type UploadErrorCode, type UploadValidation, type ValidateUploadInput } from "./validate";
export { CAPTURE_LIMITS, resolveLimits, type CaptureLimits } from "./limits";
export { checkZipSafety, readZipDirectory, checkZipEntries, type ZipEntryInfo, type ZipProblem } from "./zip";
export { chunkSegments, chunkText, locatorLabel, ocrLabel, type Segment, type ChunkingOptions } from "./chunk";
export { imageFormat, isImage, readImageHeader, type ImageFormat, type ImageHeader } from "./image";
export { DEFAULT_OCR_LANGUAGES, OcrSession, parseOcrLanguages, tesseractEngineFactory } from "./ocr";
export { parseConversation, parseMarker } from "./formats/conversation";
export { checksum, normalizeText } from "./text";
export * from "./types";
