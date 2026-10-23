import { AiError } from "./errors";
import type { AiTask, AiTaskName, TaskInput, TaskOutput } from "./tasks";

export interface AiUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface RunOptions {
  signal?: AbortSignal;
  /** Task-specific timeout. Providers should stop work when it elapses. */
  timeoutMs: number;
}

export interface ProviderResult<T> {
  output: T;
  usage: AiUsage;
  latencyMs: number;
  /** Provider id as configured in the registry and org policy. */
  provider: string;
  /** Model identifier reported by the provider (not a secret). */
  model: string;
}

/**
 * A provider executes task contracts. Implementations must honour the abort
 * signal, must not log prompt or passage text, and must return output that
 * matches the task's output schema (callers validate again regardless).
 */
export interface AiProvider {
  /** Stable id used by organisation policy, e.g. "deterministic". */
  readonly id: string;
  /** Default model label, used on run records before a response arrives. */
  readonly model: string;
  /** Whether task data leaves this process. Informational; policy still applies. */
  readonly external: boolean;
  supports(task: AiTaskName): boolean;
  /** Optional health signal. Returning false makes the registry skip it. */
  isAvailable?(): boolean;
  run<T extends AiTask>(task: T, input: TaskInput<T>, opts: RunOptions): Promise<ProviderResult<TaskOutput<T>>>;
}

/** Organisation-level AI policy, resolved by the domain layer. */
export interface OrgAiPolicy {
  /** Provider ids the organisation has approved. Nothing else may receive its data. */
  allowedProviders: readonly string[];
}

export interface ProviderRegistryConfig {
  providers: readonly AiProvider[];
  /** Ordered provider preference per task. Tasks not listed use `defaultRoute`. */
  routes?: Partial<Record<AiTaskName, readonly string[]>>;
  defaultRoute?: readonly string[];
}

/**
 * Resolves the provider for a task from configuration and org policy.
 *
 * Fallback only ever moves to the next provider that is both routed for the
 * task and allowed by policy. When none is available the registry throws an
 * `unavailable` AiError; an outage never authorises sending data to an
 * unapproved provider.
 */
export class ProviderRegistry {
  private readonly providers = new Map<string, AiProvider>();
  private readonly routes: Partial<Record<AiTaskName, readonly string[]>>;
  private readonly defaultRoute: readonly string[];
  private readonly down = new Set<string>();

  constructor(config: ProviderRegistryConfig) {
    for (const p of config.providers) {
      if (this.providers.has(p.id)) throw new Error(`duplicate AI provider id: ${p.id}`);
      this.providers.set(p.id, p);
    }
    this.routes = config.routes ?? {};
    this.defaultRoute = config.defaultRoute ?? [...this.providers.keys()];
    for (const [task, route] of Object.entries(this.routes)) {
      for (const id of route ?? []) {
        if (!this.providers.has(id)) throw new Error(`route for ${task} names unknown provider ${id}`);
      }
    }
  }

  /** Mark a provider as down (e.g. from a circuit breaker) or back up. */
  setAvailable(providerId: string, available: boolean): void {
    if (available) this.down.delete(providerId);
    else this.down.add(providerId);
  }

  /** Providers eligible for the task under the policy, in preference order. */
  candidates(task: AiTaskName, policy: OrgAiPolicy): AiProvider[] {
    const allowed = new Set(policy.allowedProviders);
    const route = this.routes[task] ?? this.defaultRoute;
    const out: AiProvider[] = [];
    for (const id of route) {
      const p = this.providers.get(id);
      if (!p || !allowed.has(id) || !p.supports(task)) continue;
      if (this.down.has(id) || p.isAvailable?.() === false) continue;
      out.push(p);
    }
    return out;
  }

  /** The preferred available, approved provider; throws `unavailable` if none. */
  resolve(task: AiTaskName, policy: OrgAiPolicy): AiProvider {
    const [first] = this.candidates(task, policy);
    if (!first) {
      throw new AiError("unavailable", `no approved AI provider is available for ${task}`);
    }
    return first;
  }

  /**
   * Run with policy-bounded fallback: tries approved candidates in order and
   * moves on only when a provider reports `unavailable`. Other failures are
   * returned to the caller unchanged.
   */
  async run<T extends AiTask>(
    task: T,
    input: TaskInput<T>,
    policy: OrgAiPolicy,
    opts: RunOptions,
  ): Promise<ProviderResult<TaskOutput<T>>> {
    const candidates = this.candidates(task.name, policy);
    if (candidates.length === 0) {
      throw new AiError("unavailable", `no approved AI provider is available for ${task.name}`);
    }
    let last: unknown;
    for (const p of candidates) {
      try {
        return await p.run(task, input, opts);
      } catch (err) {
        if (err instanceof AiError && err.category === "unavailable") {
          last = err;
          continue;
        }
        throw err;
      }
    }
    throw new AiError("unavailable", `all approved AI providers are unavailable for ${task.name}`, { cause: last });
  }
}
