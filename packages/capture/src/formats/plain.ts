import type { Segment } from "../chunk";

const FENCE = /^\s{0,3}(```|~~~)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;

/**
 * Split normalised text into paragraph segments with 1-based line ranges.
 * Markdown mode starts a new group at each ATX heading (outside code fences) and
 * keeps fenced code blocks intact.
 */
export function plainSegments(text: string, markdown: boolean): Segment[] {
  const lines = text.split("\n");
  const segments: Segment[] = [];
  let group = "body";
  let heading: string | undefined;
  let buf: string[] = [];
  let startLine = 0;
  let inFence = false;
  let sectionNo = 0;

  const flush = (endLine: number) => {
    if (buf.length === 0) return;
    const seg: Segment = { text: buf.join("\n"), group, kind: "line", index: startLine, endIndex: endLine };
    if (heading) seg.heading = heading;
    segments.push(seg);
    buf = [];
  };

  lines.forEach((line, i) => {
    const lineNo = i + 1;
    if (markdown && FENCE.test(line)) inFence = !inFence;
    const h = markdown && !inFence ? HEADING.exec(line) : null;
    if (h) {
      flush(lineNo - 1);
      sectionNo += 1;
      group = `section-${sectionNo}`;
      heading = h[2];
    }
    if (line.trim() === "" && !inFence) {
      flush(lineNo - 1);
      return;
    }
    if (buf.length === 0) startLine = lineNo;
    buf.push(line);
  });
  flush(lines.length);
  return segments;
}
