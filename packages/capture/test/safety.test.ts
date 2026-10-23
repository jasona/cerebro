import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { CAPTURE_LIMITS, checkZipSafety, detectKind, extractSource, resolveLimits, validateUpload } from "../src";
import { buildDocx, buildPdf, buildPptx } from "./fixtures";

async function bombDocx(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  zip.file("word/document.xml", "<w:document/>");
  zip.file("word/padding.xml", new Uint8Array(8 * 1024 * 1024)); // 8 MiB of zeros deflates ~1000:1
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 9 } });
}

/** Rewrite the declared uncompressed size of `name` in its local and central headers. */
function declareSize(bytes: Uint8Array, name: string, size: number): Uint8Array {
  const out = bytes.slice();
  const v = new DataView(out.buffer);
  const nameAt = (at: number, lenAt: number) => new TextDecoder().decode(out.subarray(at, at + v.getUint16(lenAt, true)));
  for (let i = 0; i + 46 <= out.length; i++) {
    const sig = v.getUint32(i, true);
    if (sig === 0x04034b50 && nameAt(i + 30, i + 26) === name) v.setUint32(i + 22, size, true);
    if (sig === 0x02014b50 && nameAt(i + 46, i + 28) === name) v.setUint32(i + 24, size, true);
  }
  return out;
}

/** A DOCX whose body inflates to ~24 MiB while its headers declare 100 kB (a lying-size zip bomb). */
async function lyingDocx(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  const body = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>hi</w:t></w:r></w:p></w:body></w:document>';
  zip.file("word/document.xml", body + " ".repeat(24 * 1024 * 1024));
  const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 9 } });
  return declareSize(bytes, "word/document.xml", 100_000);
}

describe("zip safety", () => {
  it("refuses an archive whose entries inflate beyond their declared sizes, before any parser runs", async () => {
    const bytes = await lyingDocx();
    // The declared sizes pass the header checks...
    expect("entries" in checkZipSafety(bytes, resolveLimits())).toBe(true);
    // ...but extraction verifies the real inflated sizes against them.
    const r = await extractSource({ kind: "docx", bytes });
    expect(r.status).toBe("failed");
    expect(r.errorCategory).toBe("unsafe_archive");
  });

  it("rejects archives with a suspicious compression ratio before inflating", async () => {
    const bytes = await bombDocx();
    const safety = checkZipSafety(bytes, resolveLimits());
    expect("problem" in safety && safety.problem.code).toBe("unsafe_archive");
    const r = await extractSource({ kind: "docx", bytes });
    expect(r.status).toBe("failed");
    expect(r.errorCategory).toBe("unsafe_archive");
  });

  it("rejects archives with too many entries", async () => {
    const bytes = await buildPptx([{ title: "Hi" }, { title: "There" }]);
    const r = await extractSource({ kind: "pptx", bytes }, { limits: { maxZipEntries: 3 } });
    expect(r.errorCategory).toBe("unsafe_archive");
  });

  it("rejects archives whose declared size exceeds the limit", async () => {
    const r = await extractSource({ kind: "docx", bytes: await buildDocx(["a".repeat(5000)]) }, { limits: { maxUncompressedBytes: 1000 } });
    expect(r.errorCategory).toBe("unsafe_archive");
  });

  it("accepts normal Office documents", async () => {
    const safety = checkZipSafety(await buildDocx(["fine"]), resolveLimits());
    expect("entries" in safety && safety.entries.map((e) => e.name)).toContain("word/document.xml");
  });
});

describe("validateUpload", () => {
  it("rejects files over the byte limit", () => {
    const v = validateUpload({ kind: "pdf", bytes: buildPdf([["x"]]) }, { maxBytes: 10 });
    expect(v).toMatchObject({ ok: false, error: { code: "too_large", limit: 10 } });
  });

  it("default limit is 20 MB", () => {
    expect(CAPTURE_LIMITS.maxBytes).toBe(20 * 1024 * 1024);
  });

  it("rejects a renamed file whose bytes do not match the kind", () => {
    const v = validateUpload({ kind: "pdf", bytes: new TextEncoder().encode("hello world"), filename: "fake.pdf" });
    expect(v).toMatchObject({ ok: false, error: { code: "kind_mismatch" } });
  });

  it("rejects binary bytes submitted as text", () => {
    const v = validateUpload({ kind: "markdown", bytes: buildPdf([["x"]]) });
    expect(v).toMatchObject({ ok: false, error: { code: "kind_mismatch" } });
  });

  it("identifies legacy or encrypted Office files", () => {
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    expect(detectKind("old.doc", undefined, ole)).toBeNull();
    expect(validateUpload({ kind: "docx", bytes: ole })).toMatchObject({ ok: false, error: { code: "legacy_or_encrypted_office" } });
  });

  it("rejects random binary as unsupported", async () => {
    const r = await extractSource({ kind: "pptx", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]) });
    expect(r.status).toBe("failed");
    expect(r.errorCategory).toBe("unsupported_format");
  });

  it("requires bytes for binary kinds", () => {
    expect(validateUpload({ kind: "docx" })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });
});

describe("detectKind", () => {
  it("prefers magic bytes over the filename", async () => {
    expect(detectKind("report.docx", undefined, buildPdf([["x"]]))).toBe("pdf");
    expect(detectKind("slides.pdf", "application/pdf", await buildPptx([{ title: "x" }]))).toBe("pptx");
  });

  it("falls back to filename and MIME without bytes", () => {
    expect(detectKind("notes.md")).toBe("markdown");
    expect(detectKind(undefined, "text/plain; charset=utf-8")).toBe("text");
    expect(detectKind("deck.PPTX")).toBe("pptx");
    expect(detectKind("image.png")).toBe("image");
    expect(detectKind("scan.JPG")).toBe("image");
    expect(detectKind(undefined, "image/webp")).toBe("image");
    expect(detectKind("sheet.xlsx")).toBeNull();
  });

  it("treats UTF-8 bytes as text unless named Markdown", () => {
    const bytes = new TextEncoder().encode("# Title\n\nbody");
    expect(detectKind("a.md", undefined, bytes)).toBe("markdown");
    expect(detectKind(undefined, undefined, bytes)).toBe("text");
    expect(detectKind("a.pdf", undefined, bytes)).toBeNull();
  });
});
