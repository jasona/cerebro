import { idfTable, rankPassages } from "../retrieval";
import type { AnswerInput, AnswerOutput, AnswerPart, RetrievedPassage } from "../tasks";
import { looksLikeInstruction, splitSentences, terms, tokenize } from "../text";

export interface ExtractiveAnswerOptions {
  /** Minimum BM25 score for a passage to contribute sentences. */
  minPassageScore?: number;
  /** Share of question terms the selected sentences must cover. */
  minCoverage?: number;
  maxSentences?: number;
}

const DEFAULTS = { minPassageScore: 0.5, minCoverage: 0.6, maxSentences: 3 } as const;

/** Questions that ask for material outside the reader corpus. */
const OUT_OF_SCOPE = [
  /\b(private|original|underlying|raw|full|confidential)\s+(source|sources|documents?|files?|attachments?|chunks?|transcripts?)\b/i,
  /\bsource documents?\b/i,
  /\bsystem prompt\b/i,
  /\b(other|another)\s+(company|companies|tenant|tenants|organi[sz]ations?)\b/i,
];

const REFUSAL =
  "Answers can only use this published revision and its approved evidence; private sources, other organisations' content and other readers' activity are not available.";

/**
 * Extractive, offline answering. Every answer part is a verbatim sentence from
 * a cited passage, so it cannot introduce numbers or claims the passages do
 * not contain. When coverage is too low it abstains and says what is missing.
 */
export function extractiveAnswer(input: AnswerInput, opts: ExtractiveAnswerOptions = {}): AnswerOutput {
  const minPassageScore = opts.minPassageScore ?? DEFAULTS.minPassageScore;
  const minCoverage = opts.minCoverage ?? DEFAULTS.minCoverage;
  const maxSentences = opts.maxSentences ?? DEFAULTS.maxSentences;

  if (looksLikeInstruction(input.question) || OUT_OF_SCOPE.some((re) => re.test(input.question))) {
    return { status: "refused", answer: [], citations: [], missing: REFUSAL };
  }

  const qTokens = tokenize(input.question);
  const qTerms = [...new Set(qTokens.map((t) => t.term))];
  if (qTerms.length === 0) {
    return {
      status: "insufficient",
      answer: [],
      citations: [],
      missing: "The question has no specific terms to look up in the briefing.",
    };
  }

  const ranked = rankPassages(input.question, input.passages, { focusBlockId: input.focusBlockId }).filter(
    (r) => r.score >= minPassageScore,
  );

  // Candidate sentences from qualifying passages; instruction-like text is
  // treated as data and never surfaced.
  interface Candidate {
    passage: RetrievedPassage;
    sentence: string;
    matched: Set<string>;
    rank: number;
    order: number;
  }
  const candidates: Candidate[] = [];
  ranked.forEach((r, rank) => {
    splitSentences(r.passage.text).forEach((sentence, order) => {
      if (looksLikeInstruction(sentence)) return;
      // A sentence is read in the context of its passage title ("Vendor survey notes").
      const st = new Set([...terms(sentence), ...terms(r.passage.title)]);
      const matched = new Set(qTerms.filter((t) => st.has(t)));
      if (matched.size) candidates.push({ passage: r.passage, sentence, matched, rank, order });
    });
  });

  const idf = idfTable(
    qTerms,
    input.passages.map((p) => terms(`${p.title} ${p.text}`)),
  );
  const weight = (ts: Iterable<string>) => [...ts].reduce((a, t) => a + (idf.get(t) ?? 0), 0);

  const covered = new Set<string>();
  const chosen: Candidate[] = [];
  while (chosen.length < maxSentences) {
    let best: Candidate | undefined;
    let bestGain = 0;
    for (const c of candidates) {
      if (chosen.includes(c)) continue;
      const gain = weight([...c.matched].filter((t) => !covered.has(t)));
      if (
        gain > bestGain + 1e-9 ||
        (best && Math.abs(gain - bestGain) <= 1e-9 && gain > 0 && (c.rank < best.rank || (c.rank === best.rank && c.order < best.order)))
      ) {
        best = c;
        bestGain = gain;
      }
    }
    if (!best || bestGain <= 0) break;
    chosen.push(best);
    for (const t of best.matched) covered.add(t);
  }

  const coverage = covered.size / qTerms.length;
  if (chosen.length === 0 || coverage < minCoverage) {
    const surface = new Map<string, string>();
    for (const t of qTokens) if (!surface.has(t.term)) surface.set(t.term, t.surface);
    const uncovered = qTerms.filter((t) => !covered.has(t)).map((t) => surface.get(t) ?? t);
    return {
      status: "insufficient",
      answer: [],
      citations: [],
      missing: `The published briefing and its approved evidence do not cover: ${uncovered.join(", ")}.`,
    };
  }

  // Present in reading order: by passage rank, then sentence order.
  chosen.sort((a, b) => a.rank - b.rank || a.order - b.order);
  const answer: AnswerPart[] = chosen.map((c) => ({ text: c.sentence, kind: "stated", citations: [c.passage.id] }));
  const citations = [...new Set(answer.flatMap((p) => p.citations))].map((passageId) => ({ passageId }));
  return { status: "answered", answer, citations };
}
