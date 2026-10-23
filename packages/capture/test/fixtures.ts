import JSZip from "jszip";

const enc = new TextEncoder();

function pdfEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/**
 * Hand-written minimal PDF. Each page is a list of text lines, or null for a page with
 * no text layer. Xref offsets are computed from the actual byte positions.
 */
export function buildPdf(pages: (string[] | null)[]): Uint8Array {
  const objects: string[] = [];
  const pageCount = pages.length;
  // 1: catalog, 2: pages, 3: font, then per page: page obj + content obj
  const pageIds = pages.map((_, i) => 4 + i * 2);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageCount} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  pages.forEach((lines, i) => {
    const pageId = pageIds[i]!;
    const contentId = pageId + 1;
    const ops = lines ? `BT /F1 12 Tf 72 720 Td 14 TL ${lines.map((l) => `(${pdfEscape(l)}) Tj T*`).join(" ")} ET` : "";
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`;
    objects[contentId] = `<< /Length ${ops.length} >>\nstream\n${ops}\nendstream`;
  });

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xrefAt = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) out += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return enc.encode(out); // ASCII only, so string length === byte length
}

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function buildDocx(paragraphs: string[], extraBodyXml = ""): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );
  const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(p)}</w:t></w:r></w:p>`).join("");
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${W_NS}><w:body>${body}${extraBodyXml}</w:body></w:document>`);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

const P_NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

function shape(paragraphs: string[], placeholder?: string): string {
  const ph = placeholder ? `<p:nvPr><p:ph type="${placeholder}"/></p:nvPr>` : "<p:nvPr/>";
  const ps = paragraphs.map((t) => `<a:p><a:r><a:rPr lang="en-US"/><a:t>${xmlEscape(t)}</a:t></a:r></a:p>`).join("");
  return `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Shape"/><p:cNvSpPr/>${ph}</p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/>${ps}</p:txBody></p:sp>`;
}

const PIC = `<p:pic><p:nvPicPr><p:cNvPr id="4" name="Picture"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/></p:blipFill><p:spPr/></p:pic>`;
const CHART = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="5" name="Chart"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId3"/></a:graphicData></a:graphic></p:graphicFrame>`;

export interface SlideSpec {
  title?: string;
  body?: string[];
  picture?: boolean;
  chart?: boolean;
  notes?: string[];
}

function slideXml(s: SlideSpec): string {
  const tree = [s.title ? shape([s.title], "title") : "", s.body ? shape(s.body) : "", s.picture ? PIC : "", s.chart ? CHART : ""].join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sld ${P_NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${tree}</p:spTree></p:cSld></p:sld>`;
}

/** Minimal PPTX. `partNumbers` lets a test use non-contiguous part names (slide2, slide10). */
export async function buildPptx(slides: SlideSpec[], partNumbers?: number[]): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`);
  zip.file("ppt/presentation.xml", `<?xml version="1.0" encoding="UTF-8"?><p:presentation ${P_NS}/>`);
  slides.forEach((s, i) => {
    const n = partNumbers?.[i] ?? i + 1;
    zip.file(`ppt/slides/slide${n}.xml`, slideXml(s));
    const rels: string[] = [];
    if (s.notes) {
      // Deliberately use a different notes number to exercise relationship lookup.
      const notesNo = 100 + n;
      rels.push(`<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide${notesNo}.xml"/>`);
      const notesTree = `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image"/><p:cNvSpPr/><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>${shape(s.notes, "body")}${shape(["7"], "sldNum")}`;
      zip.file(`ppt/notesSlides/notesSlide${notesNo}.xml`, `<?xml version="1.0" encoding="UTF-8"?><p:notes ${P_NS}><p:cSld><p:spTree>${notesTree}</p:spTree></p:cSld></p:notes>`);
    }
    zip.file(`ppt/slides/_rels/slide${n}.xml.rels`, `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>`);
  });
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
