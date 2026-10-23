export type ImageFormat = "png" | "jpeg" | "webp";

export interface ImageHeader {
  format: ImageFormat;
  /** Pixel dimensions declared by the header; null when the header is damaged. */
  width: number | null;
  height: number | null;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const ascii = (bytes: Uint8Array, at: number, len: number): string => String.fromCharCode(...bytes.subarray(at, at + len));

/** Image format from magic bytes: PNG, JPEG or WebP. */
export function imageFormat(bytes: Uint8Array): ImageFormat | null {
  if (bytes.length >= 8 && PNG_MAGIC.every((b, i) => bytes[i] === b)) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "webp";
  return null;
}

export function isImage(bytes: Uint8Array): boolean {
  return imageFormat(bytes) !== null;
}

function pngSize(bytes: Uint8Array): [number, number] | null {
  if (bytes.length < 24 || ascii(bytes, 12, 4) !== "IHDR") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return [view.getUint32(16), view.getUint32(20)];
}

/** Walk JPEG segments to the first start-of-frame marker. Reads headers only. */
function jpegSize(bytes: Uint8Array): [number, number] | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) return null;
    let marker = bytes[i + 1]!;
    while (marker === 0xff && i + 2 < bytes.length) {
      i += 1;
      marker = bytes[i + 1]!;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // end of image / start of scan before any frame header
    if (i + 4 > bytes.length) return null;
    const length = view.getUint16(i + 2);
    if (length < 2) return null;
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (i + 9 > bytes.length) return null;
      return [view.getUint16(i + 7), view.getUint16(i + 5)];
    }
    i += 2 + length;
  }
  return null;
}

function webpSize(bytes: Uint8Array): [number, number] | null {
  if (bytes.length < 30) return null;
  const chunk = ascii(bytes, 12, 4);
  const u24 = (at: number) => bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16);
  if (chunk === "VP8 ") {
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    return [(bytes[26]! | (bytes[27]! << 8)) & 0x3fff, (bytes[28]! | (bytes[29]! << 8)) & 0x3fff];
  }
  if (chunk === "VP8L") {
    if (bytes[20] !== 0x2f) return null;
    const bits = bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24);
    return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
  }
  if (chunk === "VP8X") return [u24(24) + 1, u24(27) + 1];
  return null;
}

/**
 * Read an image's format and declared dimensions from its header without
 * decoding pixels, so oversized images (decompression bombs) can be refused
 * before any decoder allocates memory for them.
 */
export function readImageHeader(bytes: Uint8Array): ImageHeader | null {
  const format = imageFormat(bytes);
  if (!format) return null;
  const size = format === "png" ? pngSize(bytes) : format === "jpeg" ? jpegSize(bytes) : webpSize(bytes);
  if (!size || size[0] <= 0 || size[1] <= 0) return { format, width: null, height: null };
  return { format, width: size[0], height: size[1] };
}
