import { DeterministicProvider, ProviderRegistry, type OrgAiPolicy } from "@cerebro/ai";
import { organizations, type Executor } from "@cerebro/database";
import { eq } from "drizzle-orm";

/**
 * Process-wide AI provider registry used by reader Q&A and topic summaries.
 * Defaults to the offline deterministic provider (T19). Hosts that configure
 * another provider call `setAiRegistry` at startup; org policy still decides
 * which providers may receive an organization's data.
 */
let registry: ProviderRegistry | undefined;

export function getAiRegistry(): ProviderRegistry {
  registry ??= new ProviderRegistry({ providers: [new DeterministicProvider()] });
  return registry;
}

export function setAiRegistry(next: ProviderRegistry | undefined): void {
  registry = next;
}

export const DEFAULT_ALLOWED_PROVIDERS: readonly string[] = ["deterministic"];

/**
 * Organization AI policy from `organizations.settings.ai.allowedProviders`,
 * defaulting to the deterministic provider only. A malformed value is treated
 * as "no provider allowed" rather than widened to the default.
 */
export async function resolveOrgAiPolicy(tx: Executor, organizationId: string): Promise<OrgAiPolicy> {
  const [row] = await tx
    .select({ settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  const ai = (row?.settings as { ai?: { allowedProviders?: unknown } } | null | undefined)?.ai;
  if (!ai || ai.allowedProviders === undefined) return { allowedProviders: DEFAULT_ALLOWED_PROVIDERS };
  const list = ai.allowedProviders;
  if (!Array.isArray(list) || !list.every((p): p is string => typeof p === "string")) return { allowedProviders: [] };
  return { allowedProviders: list };
}
