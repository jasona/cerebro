import type { CaptureLimits } from "./limits";

export interface ZipEntryInfo {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
}

export type ZipProblem =
  | { code: "corrupt_file"; message: string }
  | { code: "unsupported_format"; message: string }
  | { code: "unsafe_archive"; message: string };

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;

export function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/**
 * Reads the ZIP central directory without decompressing anything. Sizes are the
 * archive's own declarations; they are checked against limits before any parser
 * (JSZip, mammoth) inflates data.
 */
export function readZipDirectory(bytes: Uint8Array): { entries: ZipEntryInfo[] } | { problem: ZipProblem } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const len = bytes.length;
  if (len < 22) return { problem: { code: "corrupt_file", message: "The archive is truncated." } };

  let eocd = -1;
  const stop = Math.max(0, len - 22 - 0xffff);
  for (let i = len - 22; i >= stop; i--) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return { problem: { code: "corrupt_file", message: "The archive has no central directory." } };

  const totalEntries = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (totalEntries === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    return { problem: { code: "unsupported_format", message: "ZIP64 archives are not supported." } };
  }
  if (cdOffset + cdSize > len) return { problem: { code: "corrupt_file", message: "The archive directory is out of range." } };

  const decoder = new TextDecoder("utf-8", { fatal: false });
  const entries: ZipEntryInfo[] = [];
  let p = cdOffset;
  for (let n = 0; n < totalEntries; n++) {
    if (p + 46 > len || view.getUint32(p, true) !== CENTRAL_SIGNATURE) {
      return { problem: { code: "corrupt_file", message: "The archive directory is damaged." } };
    }
    const compressedSize = view.getUint32(p + 20, true);
    const uncompressedSize = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    if (p + 46 + nameLen > len) return { problem: { code: "corrupt_file", message: "The archive directory is damaged." } };
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      return { problem: { code: "unsupported_format", message: "ZIP64 archives are not supported." } };
    }
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    entries.push({ name, compressedSize, uncompressedSize });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { entries };
}

/** Zip-bomb and resource checks on declared sizes. Returns a problem or null. */
export function checkZipEntries(entries: ZipEntryInfo[], limits: CaptureLimits): ZipProblem | null {
  if (entries.length > limits.maxZipEntries) {
    return { code: "unsafe_archive", message: `The archive has ${entries.length} entries; the limit is ${limits.maxZipEntries}.` };
  }
  let totalCompressed = 0;
  let totalUncompressed = 0;
  for (const e of entries) {
    totalCompressed += e.compressedSize;
    totalUncompressed += e.uncompressedSize;
    if (e.uncompressedSize > limits.maxEntryUncompressedBytes) {
      return { code: "unsafe_archive", message: "An archive entry expands beyond the allowed size." };
    }
    if (e.uncompressedSize >= limits.ratioCheckMinBytes && e.uncompressedSize / Math.max(1, e.compressedSize) > limits.maxCompressionRatio) {
      return { code: "unsafe_archive", message: "An archive entry has a suspicious compression ratio (possible zip bomb)." };
    }
  }
  if (totalUncompressed > limits.maxUncompressedBytes) {
    return { code: "unsafe_archive", message: "The archive expands beyond the allowed size." };
  }
  if (totalUncompressed >= limits.ratioCheckMinBytes && totalUncompressed / Math.max(1, totalCompressed) > limits.maxCompressionRatio) {
    return { code: "unsafe_archive", message: "The archive has a suspicious compression ratio (possible zip bomb)." };
  }
  return null;
}

/** Inspect and check an archive in one step. */
export function checkZipSafety(bytes: Uint8Array, limits: CaptureLimits): { entries: ZipEntryInfo[] } | { problem: ZipProblem } {
  const dir = readZipDirectory(bytes);
  if ("problem" in dir) return dir;
  const problem = checkZipEntries(dir.entries, limits);
  return problem ? { problem } : dir;
}
