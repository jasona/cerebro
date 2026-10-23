import type { SummarizeTopicsInput, SummarizeTopicsOutput, Topic } from "../tasks";
import { tokenize } from "../text";

const MAX_EXAMPLES = 3;
const OTHER_LABEL = "Other questions";

/**
 * Deterministic keyword clustering. Greedily picks the term shared by the most
 * unassigned questions, labels the cluster with that term (plus its strongest
 * co-occurring term), and repeats. Output contains counts and question ids
 * only, never question text. Small cohorts are suppressed per the input policy.
 */
export function summarizeTopicsDeterministic(input: SummarizeTopicsInput): SummarizeTopicsOutput {
  const qs = input.questions;
  const termsByQ: Set<string>[] = [];
  const surfaces = new Map<string, Map<string, number>>();
  const postings = new Map<string, number[]>();

  qs.forEach((q, i) => {
    const set = new Set<string>();
    for (const t of tokenize(q.text)) {
      if (/^\d/.test(t.term) || t.term.length < 3) continue;
      set.add(t.term);
      const s = surfaces.get(t.term) ?? new Map<string, number>();
      const surface = t.surface.toLowerCase();
      s.set(surface, (s.get(surface) ?? 0) + 1);
      surfaces.set(t.term, s);
    }
    termsByQ.push(set);
    for (const t of set) postings.set(t, [...(postings.get(t) ?? []), i]);
  });

  const surfaceOf = (term: string) => {
    const s = surfaces.get(term);
    if (!s) return term;
    return [...s.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
  };

  const assigned = new Set<number>();
  const clusters: { label: string; members: number[] }[] = [];
  const sortedTerms = [...postings.keys()].sort();

  while (clusters.length < input.maxTopics) {
    let bestTerm: string | undefined;
    let bestMembers: number[] = [];
    for (const term of sortedTerms) {
      const members = (postings.get(term) ?? []).filter((i) => !assigned.has(i));
      if (members.length > bestMembers.length) {
        bestTerm = term;
        bestMembers = members;
      }
    }
    if (!bestTerm || bestMembers.length < 2) break;

    // Secondary term: most frequent co-occurring term within the cluster.
    const co = new Map<string, number>();
    for (const i of bestMembers) for (const t of termsByQ[i] ?? []) if (t !== bestTerm) co.set(t, (co.get(t) ?? 0) + 1);
    const [second] = [...co.entries()]
      .filter(([, n]) => n >= Math.max(2, Math.ceil(bestMembers.length / 2)))
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const label = capitalise(second ? `${surfaceOf(bestTerm)}, ${surfaceOf(second[0])}` : surfaceOf(bestTerm));

    for (const i of bestMembers) assigned.add(i);
    clusters.push({ label: label.slice(0, 120), members: bestMembers });
  }

  const rest = qs.map((_, i) => i).filter((i) => !assigned.has(i));
  if (rest.length) clusters.push({ label: OTHER_LABEL, members: rest });

  let suppressedQuestions = 0;
  const topics: Topic[] = [];
  for (const c of clusters) {
    const distinctReaders = new Set(c.members.map((i) => qs[i]!.readerHash)).size;
    if (distinctReaders < input.minDistinctReaders) {
      suppressedQuestions += c.members.length;
      continue;
    }
    topics.push({
      label: c.label,
      count: c.members.length,
      distinctReaders,
      exampleQuestionIds: c.members.slice(0, MAX_EXAMPLES).map((i) => qs[i]!.id),
      questionIds: c.members.map((i) => qs[i]!.id),
    });
  }
  topics.sort((a, b) => {
    if (a.label === OTHER_LABEL) return 1;
    if (b.label === OTHER_LABEL) return -1;
    return b.count - a.count || a.label.localeCompare(b.label);
  });
  return { topics, suppressedQuestions };
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
