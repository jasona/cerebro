/**
 * Structured JSON logger with a redaction allowlist (W4 monitoring).
 *
 * Every field passes through an allowlist of keys that, by construction,
 * carry ids, kinds, counts, durations and machine categories only. Any other
 * key is emitted as "[redacted]", so source text, prompts, questions, answers,
 * document bodies and credentials cannot reach the log by accident, even if a
 * caller passes them. Event names must be dotted machine identifiers.
 *
 * Output is one JSON object per line on stdout (warn/error on stderr). No
 * vendor is involved; hosts ship these lines wherever they choose. Level from
 * `LOG_LEVEL` (debug | info | warn | error | silent, default info; the test
 * suite runs silent).
 */

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogValue = string | number | boolean | null;
export type LogFields = Record<string, LogValue | undefined>;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** A logger whose lines all carry `bindings` (still allowlisted). */
  child(bindings: LogFields): Logger;
}

/** One emitted line, after redaction. */
export interface LogRecord {
  ts: string;
  level: LogLevel;
  event: string;
  [key: string]: LogValue;
}

export type LogSink = (record: LogRecord) => void;

/**
 * Keys allowed through with their value. Add a key only if no caller could
 * ever put content (text written by a person or a model) in it.
 */
export const LOG_FIELD_ALLOWLIST: ReadonlySet<string> = new Set([
  // identity and correlation (ids only)
  "component",
  "requestId",
  "organizationId",
  "userId",
  "connectionId",
  "briefingId",
  "revisionId",
  "sourceId",
  "jobId",
  "workerId",
  // classification
  "kind",
  "tool",
  "task",
  "provider",
  "model",
  "promptVersion",
  "via",
  "scope",
  "category",
  "status",
  "result",
  "outcome",
  "code",
  "errorCategory",
  "errorName",
  "reason",
  "detail",
  "signal",
  "check",
  // numbers
  "latencyMs",
  "durationMs",
  "intervalMs",
  "inputTokens",
  "outputTokens",
  "attempts",
  "claimed",
  "count",
  "limit",
  "windowSeconds",
  "retryAfterSeconds",
  "retainDays",
  "deleted",
  "deletedSources",
  "deletedChunks",
  "deletedObjects",
  "deletedThreads",
  "deletedMessages",
  "deletedEvents",
  "updatedDrafts",
  "queueDepth",
  "oldestQueuedSeconds",
  "retryable",
]);

export const REDACTED = "[redacted]";
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const EVENT = /^[a-z][a-z0-9_.:-]{0,79}$/;
const MAX_STRING = 300;

function minLevel(): number {
  const raw = process.env.LOG_LEVEL?.trim().toLowerCase();
  if (raw === "silent") return Number.POSITIVE_INFINITY;
  return raw && raw in LEVELS ? LEVELS[raw as LogLevel] : LEVELS.info;
}

function cleanValue(v: LogValue): LogValue {
  if (typeof v === "string") {
    // eslint-disable-next-line no-control-regex
    const s = v.replace(/[\u0000-\u001f\u007f]/g, " ");
    return s.length > MAX_STRING ? `${s.slice(0, MAX_STRING)}…` : s;
  }
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  return v;
}

/** Apply the allowlist: unknown keys and non-scalar values become "[redacted]". */
export function redactFields(fields: LogFields | undefined): Record<string, LogValue> {
  const out: Record<string, LogValue> = {};
  if (!fields) return out;
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    if (k === "ts" || k === "level" || k === "event") continue;
    const scalar = v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";
    out[k] = LOG_FIELD_ALLOWLIST.has(k) && scalar ? cleanValue(v) : REDACTED;
  }
  return out;
}

export const stdoutSink: LogSink = (record) => {
  const line = `${JSON.stringify(record)}\n`;
  (record.level === "warn" || record.level === "error" ? process.stderr : process.stdout).write(line);
};

let sink: LogSink = stdoutSink;

/** Replace the process-wide sink (tests, or a host shipping logs elsewhere). `undefined` restores stdout. */
export function setLogSink(next: LogSink | undefined): void {
  sink = next ?? stdoutSink;
}

function emit(level: LogLevel, event: string, bindings: LogFields, fields: LogFields | undefined): void {
  if (LEVELS[level] < minLevel()) return;
  const record: LogRecord = {
    ts: new Date().toISOString(),
    level,
    event: EVENT.test(event) ? event : "log.invalid_event",
    ...redactFields(bindings),
    ...redactFields(fields),
  };
  try {
    sink(record);
  } catch {
    // Logging must never break the request or job that logged.
  }
}

/** Create a logger. `bindings` (e.g. `{ component: "mcp" }`) are added to every line. */
export function createLogger(bindings: LogFields = {}): Logger {
  return {
    debug: (event, fields) => emit("debug", event, bindings, fields),
    info: (event, fields) => emit("info", event, bindings, fields),
    warn: (event, fields) => emit("warn", event, bindings, fields),
    error: (event, fields) => emit("error", event, bindings, fields),
    child: (more) => createLogger({ ...bindings, ...more }),
  };
}

export const log: Logger = createLogger();
