/// <reference path="./vendor.d.ts" />
import { dirname, join } from "node:path";
import { locatorLabel } from "./chunk";
import type { CaptureLimits } from "./limits";
import type { ExtractionGap, Locator, OcrEngine, OcrEngineFactory, OcrLine, OcrOptions, OcrRecognition } from "./types";

/** English only by default; other languages are a deployment choice (see `OcrOptions.languages`). */
export const DEFAULT_OCR_LANGUAGES: readonly string[] = Object.freeze(["eng"]);

/** Tesseract language codes such as `eng`, `deu`, `chi_sim`. Anything else is refused (they become file names). */
const LANGUAGE_CODE = /^[a-z]{3}(?:_[a-z]{3,4})?$/;

/**
 * Validate a configured language list. Returns null when it is empty or any
 * entry is not a plain Tesseract language code.
 */
export function parseOcrLanguages(languages: readonly string[] | undefined): string[] | null {
  const list = (languages ?? DEFAULT_OCR_LANGUAGES).map((l) => l.trim().toLowerCase()).filter(Boolean);
  if (list.length === 0 || !list.every((l) => LANGUAGE_CODE.test(l))) return null;
  return [...new Set(list)];
}

/** The bundled English model (`@tesseract.js-data/eng`, LSTM "best_int" data); never fetched from a CDN. */
async function bundledLangPath(): Promise<string> {
  const mod = (await import("@tesseract.js-data/eng")) as { default?: { langPath: string }; langPath?: string };
  const data = mod.default ?? (mod as { langPath: string });
  return join(dirname(data.langPath), "4.0.0_best_int");
}

interface TesseractData {
  blocks?: { paragraphs?: { lines?: { text?: string; confidence?: number }[] }[] }[] | null;
}

function toRecognition(data: TesseractData): OcrRecognition {
  const paragraphs: OcrLine[][] = [];
  for (const block of data.blocks ?? []) {
    for (const para of block.paragraphs ?? []) {
      const lines = (para.lines ?? [])
        .map((l) => ({ text: String(l.text ?? "").replace(/\s+/g, " ").trim(), confidence: Number(l.confidence ?? 0) }))
        .filter((l) => l.text);
      if (lines.length) paragraphs.push(lines);
    }
  }
  return { paragraphs };
}

/**
 * The default engine: tesseract.js (WebAssembly in a worker thread) with local
 * language data only. Nothing is downloaded and no trained data is cached to
 * disk. Worker errors reject the pending recognition instead of crashing the
 * process.
 */
export const tesseractEngineFactory: OcrEngineFactory = async ({ languages, langPath }) => {
  const mod = (await import("tesseract.js")) as unknown as { default?: typeof import("tesseract.js") } & typeof import("tesseract.js");
  const tesseract = mod.default ?? mod;
  let fail: (err: unknown) => void = () => undefined;
  const crashed = new Promise<never>((_, reject) => {
    fail = reject;
  });
  crashed.catch(() => undefined);
  const worker = await tesseract.createWorker([...languages], 1 /* OEM.LSTM_ONLY */, {
    langPath: langPath ?? (await bundledLangPath()),
    cacheMethod: "none",
    gzip: true,
    logger: () => undefined,
    // Without a handler tesseract.js rethrows worker errors from a message listener (an uncaught exception).
    errorHandler: (err: unknown) => fail(err),
  });
  const thread = (worker as unknown as { worker?: { on?: (event: string, fn: (arg: unknown) => void) => void } }).worker;
  thread?.on?.("error", (err) => fail(err));
  return {
    async recognize(png) {
      const res = await Promise.race([worker.recognize(Buffer.from(png.buffer, png.byteOffset, png.byteLength), {}, { text: false, blocks: true }), crashed]);
      return toRecognition(res.data as TesseractData);
    },
    async terminate() {
      await worker.terminate().catch(() => undefined);
    },
  };
};

class OcrTimeout extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new OcrTimeout()), Math.max(1, ms));
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export type OcrRead =
  | { ok: true; text: string; confidence: number; gaps: ExtractionGap[] }
  | { ok: false; gap: ExtractionGap };

function where(loc: Locator): string {
  return loc.kind === "image" ? "The image" : `Page ${loc.index}`;
}

/**
 * OCR for one extraction: creates the engine lazily, enforces the per-page and
 * total time limits, and turns every failure into a gap. Once OCR fails or a
 * time limit is reached, later pages are not attempted. Never logs or returns
 * recognised text in gaps. Call `close()` when the extraction ends.
 */
export class OcrSession {
  readonly enabled: boolean;
  private engine: Promise<OcrEngine> | null = null;
  private readonly startedAt = Date.now();
  private stopped: { code: "ocr_failed" | "ocr_limit"; reason: string } | null = null;
  private readonly languages: string[] | null;

  constructor(
    private readonly options: OcrOptions,
    private readonly limits: CaptureLimits,
  ) {
    this.enabled = options.enabled !== false;
    this.languages = parseOcrLanguages(options.languages);
    if (this.enabled && !this.languages) this.stopped = { code: "ocr_failed", reason: "the OCR language setting is not valid" };
    if (this.enabled && options.langPath !== undefined && /^[a-z][a-z0-9+.-]*:/i.test(options.langPath) && !/^[a-z]:[\\/]/i.test(options.langPath)) {
      // Language data must be local; a URL would mean fetching at runtime.
      this.stopped = { code: "ocr_failed", reason: "OCR language data must be a local directory" };
    }
  }

  /** Read one encoded PNG. `loc` locates the page or image in gaps. */
  async read(png: Uint8Array, loc: Locator): Promise<OcrRead> {
    if (this.stopped) return { ok: false, gap: { code: this.stopped.code, message: `${where(loc)} was not read by OCR: ${this.stopped.reason}.`, locator: loc, affectsCompleteness: true } };
    const remaining = this.limits.ocrTotalTimeoutMs - (Date.now() - this.startedAt);
    if (remaining <= 0) return this.stop(loc, "ocr_limit", "the OCR time limit for this source was reached");

    try {
      this.engine ??= (this.options.engineFactory ?? tesseractEngineFactory)({
        languages: this.languages!,
        ...(this.options.langPath !== undefined ? { langPath: this.options.langPath } : {}),
      });
      const engine = await withTimeout(this.engine, Math.min(this.limits.ocrPageTimeoutMs, remaining));
      const left = this.limits.ocrTotalTimeoutMs - (Date.now() - this.startedAt);
      const result = await withTimeout(engine.recognize(png), Math.min(this.limits.ocrPageTimeoutMs, left));
      return this.assemble(result, loc);
    } catch (err) {
      // Deliberately no error text: it may quote content or paths.
      if (err instanceof OcrTimeout) {
        await this.close(); // terminate the busy worker
        return this.stop(loc, "ocr_limit", "OCR exceeded its time limit");
      }
      await this.close();
      return this.stop(loc, "ocr_failed", "OCR could not process it");
    }
  }

  /** Report this page and stop OCR for the rest of the source. */
  private stop(loc: Locator, code: "ocr_failed" | "ocr_limit", reason: string): OcrRead {
    this.stopped = { code, reason: code === "ocr_limit" ? "OCR stopped earlier in this source at a time limit" : "OCR stopped earlier in this source after an error" };
    return { ok: false, gap: { code, message: `${where(loc)} was not read by OCR: ${reason}.`, locator: loc, affectsCompleteness: true } };
  }

  /** Keep lines at or above the confidence threshold; report the rest as a gap. */
  private assemble(result: OcrRecognition, loc: Locator): OcrRead {
    const min = this.limits.minOcrLineConfidence;
    const gaps: ExtractionGap[] = [];
    let dropped = 0;
    let weighted = 0;
    let characters = 0;
    const paragraphs: string[] = [];
    for (const para of result.paragraphs) {
      const kept: string[] = [];
      for (const line of para) {
        if (line.confidence < min) {
          dropped += 1;
          continue;
        }
        kept.push(line.text);
        weighted += line.confidence * line.text.length;
        characters += line.text.length;
      }
      if (kept.length) paragraphs.push(kept.join("\n"));
    }
    if (dropped > 0) {
      gaps.push({
        code: "ocr_low_confidence",
        message: `${where(loc)}: ${dropped} line${dropped === 1 ? "" : "s"} recognised with low OCR confidence ${dropped === 1 ? "was" : "were"} left out; check the original.`,
        locator: loc,
        affectsCompleteness: true,
      });
    }
    const confidence = characters > 0 ? Math.round(weighted / characters) : 0;
    return { ok: true, text: paragraphs.join("\n\n"), confidence, gaps };
  }

  /** Terminate the engine. Never waits on an engine that is still starting (e.g. after a start-up timeout). */
  async close(): Promise<void> {
    const engine = this.engine;
    this.engine = null;
    if (!engine) return;
    const terminated = engine.then((e) => e.terminate()).catch(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    const giveUp = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 1_000);
      timer.unref?.();
    });
    await Promise.race([terminated, giveUp]).finally(() => clearTimeout(timer));
  }
}

/** Informational gap marking machine-read text, so the author checks it against the original. */
export function ocrUsedGap(loc: Locator, confidence: number): ExtractionGap {
  return {
    code: "ocr_used",
    message: `${where(loc)} was machine-read by OCR (${confidence}% mean confidence); check the text against the original.`,
    locator: loc,
    affectsCompleteness: false,
  };
}

export function plainLocator(kind: "page" | "image", index: number): Locator {
  return { kind, index, label: locatorLabel(kind, index) };
}
