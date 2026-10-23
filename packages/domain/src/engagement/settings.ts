/**
 * Provisional engagement settings. Every value here is an implementation
 * placeholder pending review (D07, AI_AND_EVIDENCE.md "Reader privacy and
 * topic analysis"); none is an agreed product target.
 */
export const ENGAGEMENT_SETTINGS = {
  /** D07: a topic or distinct-reader count is withheld below this many distinct readers. Provisional. */
  minCohort: 3,
  /** Reader questions per user per briefing per rolling hour. Provisional. */
  askRateLimitPerHour: 30,
  /** Passages handed to the answer task per question. */
  retrievalTopK: 24,
  /** Answer task timeout. */
  answerTimeoutMs: 15_000,
  /** Topic summary task timeout. */
  topicsTimeoutMs: 30_000,
  /** Maximum topics stored per summary run. */
  maxTopics: 10,
} as const;

/** Reserved topic label used to store the suppressed-question count of a summary run. */
export const SUPPRESSED_TOPIC = "__suppressed__";

/** Shown with every author-facing engagement view. Describes what is and is not measured. */
export const ENGAGEMENT_DISCLOSURE =
  "Measured events are counts of reader actions (opens, section views, evidence opens) recorded under " +
  "pseudonymous keys; they show activity, not comprehension or agreement. Reader questions are private to the " +
  "reader: you see only how many were asked and generated topic summaries, and a topic or reader count is " +
  `withheld unless it draws on at least ${ENGAGEMENT_SETTINGS.minCohort} distinct readers. Generated topic ` +
  "summaries are automated groupings and may be imprecise. Reader statements are feedback a reader explicitly " +
  "chose to submit with their name.";

/** Labels distinguishing observations from interpretations (SECURITY_AND_PUBLICATION.md "Privacy and analytics"). */
export const ENGAGEMENT_LABELS = {
  measured: "measured_events",
  generated: "generated_topic_summaries",
  statements: "reader_statements",
} as const;
