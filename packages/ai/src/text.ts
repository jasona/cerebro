/**
 * Small, dependency-free text utilities shared by the deterministic provider,
 * retrieval ranking and answer validation. They are heuristics, not NLP.
 */

const STOPWORDS = new Set(
  `a about above after again against all also am an and any are aren't as at be because been before being below
  between both but by can can't cannot could couldn't did didn't do does doesn't doing don't down during each few
  for from further had hadn't has hasn't have haven't having he her here hers herself him himself his how i if in
  into is isn't it it's its itself just let's me more most much many my myself no nor not of off on once only or
  other ought our ours ourselves out over own same shall she should shouldn't so some such than that that's the
  their theirs them themselves then there there's these they this those through to too under until up upon very
  was wasn't we were weren't what what's when where which while who whom whose why will with won't would wouldn't
  you your yours yourself yourselves us
  tell explain describe please say says said give show briefing brief document exactly precisely really etc`
    .split(/\s+/)
    .filter(Boolean),
);

/** Light suffix stripping so that "costs", "costing" and "cost" align. */
export function stem(word: string): string {
  let w = word.toLowerCase().replace(/['’]s$/, "");
  if (w.length <= 3) return w;
  if (w.endsWith("ies") && w.length > 4) w = `${w.slice(0, -3)}y`;
  else if (w.endsWith("sses")) w = w.slice(0, -2);
  else if (w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us") && !w.endsWith("is")) w = w.slice(0, -1);

  if (w.endsWith("ations") && w.length > 8) w = w.slice(0, -6);
  else if (w.endsWith("ation") && w.length > 7) w = w.slice(0, -5);
  else if (w.endsWith("ing") && w.length > 5) w = w.slice(0, -3);
  else if (w.endsWith("ed") && w.length > 4) w = w.slice(0, -2);
  else if (w.endsWith("ly") && w.length > 4) w = w.slice(0, -2);
  else if (w.endsWith("ate") && w.length > 6) w = w.slice(0, -3);
  else if (w.endsWith("ment") && w.length > 7) w = w.slice(0, -4);

  if (w.endsWith("e") && w.length > 3) w = w.slice(0, -1);
  return w;
}

export interface Token {
  /** Normalised term used for matching. */
  term: string;
  /** The word as written, for human-readable "missing" messages. */
  surface: string;
}

/** Tokenise into content terms: stopwords removed, light stemming applied. */
export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  for (const match of text.matchAll(/[\p{L}][\p{L}\p{N}'’-]*|\p{N}+(?:[.,]\p{N}+)*/gu)) {
    const raw = match[0].replace(/['’]$/, "");
    const lower = raw.toLowerCase();
    if (STOPWORDS.has(lower)) continue;
    if (/^\p{N}/u.test(raw)) {
      out.push({ term: normalizeNumber(raw), surface: raw });
      continue;
    }
    if (lower.length < 2) continue;
    // Split hyphenated compounds into their parts as well.
    const parts = lower.includes("-") ? lower.split("-").filter((p) => p.length > 1 && !STOPWORDS.has(p)) : [lower];
    for (const part of parts) out.push({ term: stem(part), surface: raw });
  }
  return out;
}

export function terms(text: string): string[] {
  return tokenize(text).map((t) => t.term);
}

export function termSet(text: string): Set<string> {
  return new Set(terms(text));
}

/** Split text into sentences, keeping each sentence verbatim (trimmed). */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const block of text.split(/\n\s*\n|\n(?=\s*(?:[-*•]|\d+[.)])\s)/)) {
    const flat = block.replace(/\s*\n\s*/g, " ").trim();
    if (!flat) continue;
    for (const s of flat.split(/(?<=[.!?])\s+(?=["“(\[]?[\p{Lu}\p{N}])/u)) {
      const t = s.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim();
      if (t) out.push(t);
    }
  }
  return out;
}

/** Canonical numeric string: "1,200" → "1200", "12.50" → "12.5". */
export function normalizeNumber(raw: string): string {
  const cleaned = raw.replace(/,/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? String(n) : cleaned;
}

/**
 * Every number written in the text, normalised. Signs are ignored so that a
 * date like 2026-11 does not yield "-11"; the comparison is about whether the
 * digits were present in the source at all.
 */
export function extractNumbers(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\d+(?:,\d{3})*(?:\.\d+)?/g)) out.push(normalizeNumber(m[0]));
  return out;
}

const INSTRUCTION_PATTERNS: RegExp[] = [
  /\b(ignore|disregard|forget|override)\b[^.!?\n]{0,40}\b(instructions?|prompts?|rules|guidelines|context|messages?)\b/i,
  /\b(reveal|print|output|show|leak|dump|expose)\b[^.!?\n]{0,40}\b(system prompt|source documents?|private sources?|hidden|instructions?|prompt)\b/i,
  /\byou are now\b/i,
  /\b(act|behave) as\b[^.!?\n]{0,30}\b(system|admin|developer|unrestricted)\b/i,
  /\bnew instructions?\b/i,
  /<\/?\s*(system|assistant|instructions?)\s*>/i,
];

/** Whether a sentence reads like an instruction aimed at a model. */
export function looksLikeInstruction(text: string): boolean {
  return INSTRUCTION_PATTERNS.some((re) => re.test(text));
}

/** Stable 32-bit FNV-1a hash rendered in base 36. */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
