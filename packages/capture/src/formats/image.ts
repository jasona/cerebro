import type { Segment } from "../chunk";
import { readImageHeader } from "../image";
import type { CaptureLimits } from "../limits";
import { ocrUsedGap, plainLocator, type OcrSession } from "../ocr";
import { normalizeText } from "../text";
import type { ExtractionGap } from "../types";

export class ImageOpenError extends Error {
  constructor(readonly category: "corrupt_file" | "too_large") {
    super(category === "too_large" ? "The image is too large to process." : "The image could not be read.");
  }
}

type CanvasModule = typeof import("@napi-rs/canvas");

export async function loadCanvasModule(): Promise<CanvasModule> {
  const mod = (await import("@napi-rs/canvas")) as CanvasModule & { default?: CanvasModule };
  return mod.default?.createCanvas ? mod.default : mod;
}

/** Scale factor (≤ 1) that fits `width × height` within `maxPixels`. */
export function fitScale(width: number, height: number, maxPixels: number): number {
  return Math.min(1, Math.sqrt(maxPixels / Math.max(1, width * height)));
}

/**
 * OCR a PNG, JPEG or WebP image. Dimensions are checked from the header before
 * decoding (`validateUpload` has already refused oversized images); the image
 * is decoded with @napi-rs/canvas (prebuilt, no system libraries), flattened
 * onto white, scaled down to `maxOcrPixels` if needed, and recognised locally.
 * The result is candidate text with an "Image (OCR, …)" locator.
 */
export async function extractImage(bytes: Uint8Array, limits: CaptureLimits, ocr: OcrSession): Promise<{ segments: Segment[]; gaps: ExtractionGap[] }> {
  const loc = plainLocator("image", 1);
  const header = readImageHeader(bytes);
  if (!header || header.width === null || header.height === null) throw new ImageOpenError("corrupt_file");
  if (header.width * header.height > limits.maxImagePixels || Math.max(header.width, header.height) > limits.maxImageDimension) {
    throw new ImageOpenError("too_large");
  }
  if (!ocr.enabled) {
    return { segments: [], gaps: [{ code: "image_not_extracted", message: "The image was not read because OCR is turned off.", locator: loc, affectsCompleteness: true }] };
  }

  const canvasModule = await loadCanvasModule();
  let png: Uint8Array;
  try {
    const image = await canvasModule.loadImage(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    // Trust the decoder's dimensions only if they match the checked header.
    if (image.width !== header.width || image.height !== header.height) throw new ImageOpenError("corrupt_file");
    const scale = fitScale(image.width, image.height, limits.maxOcrPixels);
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const canvas = canvasModule.createCanvas(width, height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(image, 0, 0, width, height);
    png = await canvas.encode("png");
  } catch (err) {
    if (err instanceof ImageOpenError) throw err;
    throw new ImageOpenError("corrupt_file");
  }

  const read = await ocr.read(png, loc);
  if (!read.ok) return { segments: [], gaps: [read.gap] };
  const text = normalizeText(read.text);
  const gaps = [...read.gaps];
  if (!text) {
    gaps.push({ code: "image_only", message: "OCR found no readable text in the image.", locator: loc, affectsCompleteness: true });
    return { segments: [], gaps };
  }
  gaps.unshift(ocrUsedGap(loc, read.confidence));
  return { segments: [{ text, group: "image", kind: "image", index: 1, ocrConfidence: read.confidence }], gaps };
}
