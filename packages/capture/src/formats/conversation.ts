import type { Segment } from "../chunk";
import type { MessageRole } from "../types";

interface Marker {
  role: MessageRole;
  speaker: string;
  /** Content on the same line after the marker, if any. */
  rest: string;
}

const ROLE_WORDS: Record<string, MessageRole> = {
  user: "user",
  you: "user",
  "you said": "user",
  human: "user",
  me: "user",
  assistant: "assistant",
  "chatgpt said": "assistant",
  chatgpt: "assistant",
  claude: "assistant",
  "claude said": "assistant",
  ai: "assistant",
  system: "system",
};

const NAME = "(You said|ChatGPT said|Claude said|User|Assistant|Human|ChatGPT|Claude|System|You|AI|Me)";
// "User: hi", "**User:** hi", "You said:" (inline prefix forms; plain "You"/"Me"/"AI" require a colon)
const INLINE = new RegExp(`^\\s*(?:\\*\\*|__)?${NAME}\\s*:(?:\\*\\*|__)?\\s*(?:\\*\\*|__)?(.*)$`, "i");
// "## User", "### Assistant:", "# You said:"
const HEADER = new RegExp(`^\\s{0,3}#{1,6}\\s*(?:\\*\\*)?${NAME}\\s*:?(?:\\*\\*)?\\s*$`, "i");
const FENCE = /^\s{0,3}(```|~~~)/;

export function parseMarker(line: string): Marker | null {
  const h = HEADER.exec(line);
  if (h) {
    const name = h[1]!;
    return { role: ROLE_WORDS[name.toLowerCase()]!, speaker: displayName(name), rest: "" };
  }
  const m = INLINE.exec(line);
  if (m) {
    const name = m[1]!;
    return { role: ROLE_WORDS[name.toLowerCase()]!, speaker: displayName(name), rest: m[2]!.trim() };
  }
  return null;
}

function displayName(name: string): string {
  const base = name.replace(/\s+said$/i, "");
  const lower = base.toLowerCase();
  if (lower === "chatgpt") return "ChatGPT";
  if (lower === "ai") return "AI";
  return base.charAt(0).toUpperCase() + base.slice(1).toLowerCase();
}

export interface ParsedConversation {
  /** Lines before the first speaker marker, as line-located segments. */
  preamble: Segment[];
  messages: Segment[];
}

/**
 * Parse a pasted chat transcript into message segments. Markers inside fenced code
 * blocks are ignored. Message text is untrusted content: a message that claims to be
 * a "System:" instruction is recorded as data with role "system", nothing more.
 */
export function parseConversation(text: string): ParsedConversation {
  const lines = text.split("\n");
  const preambleLines: { line: string; no: number }[] = [];
  const messages: Segment[] = [];
  let current: { marker: Marker; lines: string[] } | null = null;
  let inFence = false;

  const close = () => {
    if (!current) return;
    const body = current.lines.join("\n").trim();
    if (body) {
      const n = messages.length + 1;
      messages.push({ text: body, group: `message-${n}`, kind: "message", index: n, role: current.marker.role, speaker: current.marker.speaker });
    }
    current = null;
  };

  lines.forEach((line, i) => {
    if (FENCE.test(line)) inFence = !inFence;
    const marker = inFence ? null : parseMarker(line);
    if (marker) {
      close();
      current = { marker, lines: marker.rest ? [marker.rest] : [] };
      return;
    }
    if (current) (current as { lines: string[] }).lines.push(line);
    else preambleLines.push({ line, no: i + 1 });
  });
  close();

  const preamble: Segment[] = [];
  const nonBlank = preambleLines.filter((l) => l.line.trim() !== "");
  if (nonBlank.length > 0) {
    const first = nonBlank[0]!.no;
    const last = nonBlank[nonBlank.length - 1]!.no;
    const body = preambleLines.filter((l) => l.no >= first && l.no <= last).map((l) => l.line).join("\n");
    preamble.push({ text: body, group: "preamble", kind: "line", index: first, endIndex: last });
  }
  return { preamble, messages };
}
