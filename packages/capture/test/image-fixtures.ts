import { deflateSync } from "node:zlib";
import { createCanvas } from "@napi-rs/canvas";

export interface TextImageOptions {
  width?: number;
  height?: number;
  fontPx?: number;
  format?: "png" | "jpeg" | "webp";
}

/** Draw black text lines on white with @napi-rs/canvas; generated in-test, never committed. */
function drawLines(lines: string[], opts: TextImageOptions) {
  const fontPx = opts.fontPx ?? 40;
  const width = opts.width ?? 1400;
  const height = opts.height ?? Math.max(200, 80 + lines.length * fontPx * 2);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#000000";
  ctx.font = `${fontPx}px sans-serif`;
  lines.forEach((line, i) => ctx.fillText(line, 60, 60 + fontPx + i * fontPx * 2));
  return { canvas, ctx, width, height };
}

export async function textImage(lines: string[], opts: TextImageOptions = {}): Promise<Uint8Array> {
  const { canvas } = drawLines(lines, opts);
  const format = opts.format ?? "png";
  if (format === "jpeg") return canvas.encode("jpeg", 92);
  if (format === "webp") return canvas.encode("webp", 92);
  return canvas.encode("png");
}

/** A page is text-layer lines, a scanned image of text lines (no text layer), or blank. */
export type PdfPageSpec = { text: string[] } | { scan: string[] } | { blank: true };

function pdfEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/**
 * Minimal PDF whose scanned pages are a full-page grayscale image (FlateDecode
 * XObject) with no text layer, as a scanner produces. Offsets are exact.
 */
export function buildScannedPdf(pages: PdfPageSpec[], page: { width: number; height: number } = { width: 612, height: 792 }): Uint8Array {
  const objects: Buffer[] = [];
  const add = (body: Buffer | string): number => {
    objects.push(typeof body === "string" ? Buffer.from(body, "latin1") : body);
    return objects.length;
  };
  const stream = (dict: string, data: Buffer) =>
    Buffer.concat([Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`, "latin1"), data, Buffer.from("\nendstream", "latin1")]);

  const catalog = add("<< /Type /Catalog /Pages 2 0 R >>");
  const pagesId = add(""); // filled in below
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const kids: number[] = [];
  for (const spec of pages) {
    let resources = `<< /Font << /F1 ${font} 0 R >> >>`;
    let ops = "";
    if ("text" in spec) {
      ops = `BT /F1 12 Tf 72 ${page.height - 72} Td 14 TL ${spec.text.map((l) => `(${pdfEscape(l)}) Tj T*`).join(" ")} ET`;
    } else if ("scan" in spec) {
      // Rasterised at 150 dpi, like a scanner.
      const w = Math.round((page.width / 72) * 150);
      const h = Math.round((page.height / 72) * 150);
      const { ctx } = drawLines(spec.scan, { width: w, height: h, fontPx: 36 });
      const rgba = ctx.getImageData(0, 0, w, h).data;
      const gray = Buffer.alloc(w * h);
      for (let i = 0; i < w * h; i++) gray[i] = rgba[i * 4]!;
      const img = add(stream(`/Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`, deflateSync(gray)));
      resources = `<< /XObject << /Im1 ${img} 0 R >> >>`;
      ops = `q ${page.width} 0 0 ${page.height} 0 0 cm /Im1 Do Q`;
    }
    const content = add(stream("", Buffer.from(ops, "latin1")));
    kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${page.width} ${page.height}] /Resources ${resources} /Contents ${content} 0 R >>`));
  }
  objects[pagesId - 1] = Buffer.from(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`, "latin1");

  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n", "latin1")];
  let offset = parts[0]!.length;
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(offset);
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, "latin1"), body, Buffer.from("\nendobj\n", "latin1")]);
    parts.push(chunk);
    offset += chunk.length;
  });
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) xref += `${String(o).padStart(10, "0")} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
  parts.push(Buffer.from(xref, "latin1"));
  return new Uint8Array(Buffer.concat(parts));
}

/** A PNG signature and IHDR declaring the given size, with no pixel data: for header-only limit checks. */
export function pngHeaderOnly(width: number, height: number): Uint8Array {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  b[24] = 8; // bit depth
  b[25] = 0; // grayscale
  return new Uint8Array(b);
}
