import { AiError } from "../errors";
import type { AiProvider, ProviderResult, RunOptions } from "../provider";
import {
  AnswerInput,
  ComposeInput,
  ProposeRevisionInput,
  SummarizeTopicsInput,
  type AiTask,
  type AiTaskName,
  type TaskInput,
  type TaskOutput,
} from "../tasks";
import { extractiveAnswer, type ExtractiveAnswerOptions } from "./answer";
import { composeDeterministic } from "./compose";
import { proposeRevisionDeterministic } from "./revise";
import { summarizeTopicsDeterministic } from "./topics";

export { extractiveAnswer, type ExtractiveAnswerOptions } from "./answer";
export { composeDeterministic } from "./compose";
export { proposeRevisionDeterministic, UNSUPPORTED_INSTRUCTION } from "./revise";
export { summarizeTopicsDeterministic } from "./topics";

export interface DeterministicProviderOptions {
  id?: string;
  answer?: ExtractiveAnswerOptions;
}

/**
 * Offline default provider. No model, no network, no data leaves the process.
 * It maps, extracts and clusters; it does not write new prose, and says so.
 */
export class DeterministicProvider implements AiProvider {
  readonly id: string;
  readonly model = "deterministic-v1";
  readonly external = false;
  private readonly answerOptions: ExtractiveAnswerOptions;

  constructor(opts: DeterministicProviderOptions = {}) {
    this.id = opts.id ?? "deterministic";
    this.answerOptions = opts.answer ?? {};
  }

  supports(_task: AiTaskName): boolean {
    return true;
  }

  async run<T extends AiTask>(task: T, input: TaskInput<T>, opts: RunOptions): Promise<ProviderResult<TaskOutput<T>>> {
    if (opts.signal?.aborted) throw new AiError("aborted", "run aborted before start");
    const started = performance.now();
    const output = this.dispatch(task.name, input);
    return {
      output: output as TaskOutput<T>,
      usage: {},
      latencyMs: performance.now() - started,
      provider: this.id,
      model: this.model,
    };
  }

  private dispatch(name: AiTaskName, raw: unknown): unknown {
    const parse = <S extends { safeParse(v: unknown): { success: true; data: unknown } | { success: false } }>(s: S) => {
      const r = s.safeParse(raw);
      if (!r.success) throw new AiError("invalid_input", `invalid ${name} input`);
      return r.data;
    };
    switch (name) {
      case "answer":
        return extractiveAnswer(parse(AnswerInput) as AnswerInput, this.answerOptions);
      case "compose":
        return composeDeterministic(parse(ComposeInput) as ComposeInput);
      case "propose_revision":
        return proposeRevisionDeterministic(parse(ProposeRevisionInput) as ProposeRevisionInput);
      case "summarize_topics":
        return summarizeTopicsDeterministic(parse(SummarizeTopicsInput) as SummarizeTopicsInput);
    }
  }
}
