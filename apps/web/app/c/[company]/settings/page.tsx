import type { Metadata } from "next";
import { getAuthoringContext, listConnections } from "@cerebro/domain";
import { Badge, Card, Input, Textarea } from "@cerebro/ui";
import { Hidden } from "@/components/admin/confirm";
import { ActionForm } from "@/components/forms/action-form";
import { ThemeSwitch } from "@/components/theme-switch";
import { PageContainer, PageHeader } from "@/components/library/page-header";
import { getRequestContext } from "@/lib/context";
import { appUrl } from "@/lib/env";
import { loadOrThrow } from "@/lib/errors";
import { formatDateTime } from "@/lib/format";
import { createConnectionTokenAction, revokeConnectionAction, savePreferencesAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage({ params }: { params: Promise<{ company: string }> }) {
  const { company } = await params;
  const ws = await getRequestContext(company);
  const slug = ws.org.slug;
  const [connections, authoring] = await Promise.all([
    loadOrThrow(() => listConnections(ws.db, ws.ctx)),
    loadOrThrow(() => getAuthoringContext(ws.db, ws.ctx)),
  ]);
  const prefs = authoring.preferences;
  const currentHome = prefs.defaultTeam && !prefs.defaultTeam.stale
    ? `t:${prefs.defaultTeam.id}`
    : prefs.defaultDepartment && !prefs.defaultDepartment.stale
      ? `d:${prefs.defaultDepartment.id}`
      : "";
  const stale = [prefs.defaultDepartment, prefs.defaultTeam].find((p) => p?.stale);
  const active = connections.filter((c) => c.status === "active");
  const revoked = connections.filter((c) => c.status === "revoked");
  const mcpUrl = `${appUrl()}/api/mcp`;

  return (
    <PageContainer width="narrow">
      <PageHeader
        eyebrow={`${ws.org.name} / Settings`}
        title="Settings"
        size="headline"
        description={`Your connections and authoring defaults for ${ws.org.name}. These settings apply only to your account.`}
      />

      <section aria-labelledby="connections-heading" className="mt-10 flex flex-col gap-5">
        <div>
          <h2 id="connections-heading" className="font-serif text-title text-ink">
            LLM connections
          </h2>
          <p className="mt-1 text-sm text-muted">
            Connect your LLM so you can draft, review and publish briefs from the conversation where your thinking
            already is. A connected LLM acts as you, with your permissions; publishing still requires your explicit
            instruction.
          </p>
        </div>

        <Card tone="subtle">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-medium text-ink">Create a connection token</h3>
            <Badge tone="warning">Development connection token, not production OAuth</Badge>
          </div>
          <p className="mt-2 text-sm text-muted">
            MCP endpoint: <code className="rounded-sm bg-surface px-1.5 py-0.5 font-mono text-[0.8125rem] text-ink">{mcpUrl}</code>
          </p>
          <ol className="mt-2 list-decimal pl-5 text-sm text-muted">
            <li>Name the connection after the client you will use it in.</li>
            <li>Copy the token shown once after creation.</li>
            <li>
              In your MCP client, add a Streamable HTTP server with the endpoint above and the header{" "}
              <code className="font-mono text-[0.8125rem]">Authorization: Bearer &lt;token&gt;</code>.
            </li>
          </ol>
          <ActionForm action={createConnectionTokenAction} submitLabel="Create token" resetOnSuccess inline className="mt-4">
            <Hidden fields={{ company: slug }} />
            <Input id="conn-label" name="label" label="Connection name" placeholder="e.g. Claude Desktop on my laptop" required maxLength={100} fieldClassName="min-w-64 flex-1" />
          </ActionForm>
        </Card>

        <div>
          <h3 className="font-medium text-ink">Active connections</h3>
          {active.length === 0 ? (
            <p className="mt-2 text-sm text-muted">No active connections.</p>
          ) : (
            <ul className="mt-2 divide-y divide-line border-y border-line">
              {active.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div>
                    <p className="font-medium text-ink">{c.label}</p>
                    <p className="text-sm text-muted">
                      {c.tokenPrefix ? <code className="font-mono">{c.tokenPrefix}…</code> : c.kind} · Created {formatDateTime(c.createdAt)} ·{" "}
                      {c.lastUsedAt ? `Last used ${formatDateTime(c.lastUsedAt)}` : "Never used"}
                    </p>
                  </div>
                  <ActionForm
                    action={revokeConnectionAction}
                    submitLabel="Revoke"
                    submitAriaLabel={`Revoke connection ${c.label}`}
                    submitVariant="secondary"
                    submitSize="sm"
                    quietSuccess
                  >
                    <Hidden fields={{ company: slug, connectionId: c.id }} />
                  </ActionForm>
                </li>
              ))}
            </ul>
          )}
          {revoked.length ? (
            <details className="mt-3 text-sm">
              <summary className="cursor-pointer text-muted">{revoked.length} revoked</summary>
              <ul className="mt-2 flex flex-col gap-1 text-muted">
                {revoked.map((c) => (
                  <li key={c.id}>
                    {c.label} · revoked {c.revokedAt ? formatDateTime(c.revokedAt) : ""}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      </section>

      <section aria-labelledby="appearance-heading" className="mt-12 flex flex-col gap-4">
        <div>
          <h2 id="appearance-heading" className="font-serif text-title text-ink">
            Appearance
          </h2>
          <p className="mt-1 text-sm text-muted">Saved in this browser. System follows your device&apos;s light or dark setting.</p>
        </div>
        <ThemeSwitch className="max-w-xs" />
      </section>

      <section aria-labelledby="prefs-heading" className="mt-12 flex flex-col gap-4">
        <div>
          <h2 id="prefs-heading" className="font-serif text-title text-ink">
            Authoring preferences
          </h2>
          <p className="mt-1 text-sm text-muted">
            Your connected LLM uses these when you don&apos;t name a destination. The audience is always shown separately
            before you publish.
          </p>
        </div>
        {stale ? (
          <p role="status" className="rounded-md bg-warning-soft px-4 py-3 text-sm text-warning">
            Your remembered home {stale.name ? `(${stale.name}) ` : ""}is {stale.staleReason === "archived" ? "archived" : "no longer available to you"} and is not
            being used. Choose a new default.
          </p>
        ) : null}
        <Card>
          <ActionForm action={savePreferencesAction} submitLabel="Save preferences">
            <Hidden fields={{ company: slug }} />
            <div className="flex flex-col gap-1.5">
              <label htmlFor="pref-home" className="text-sm font-medium text-ink">
                Default home for new briefs
              </label>
              <select id="pref-home" name="home" defaultValue={currentHome} aria-describedby="pref-home-hint" className="rounded-md border border-line-strong bg-surface px-3 py-2 text-base">
                <option value="">No default (company level, or ask each time)</option>
                {authoring.destinations.departments.length ? (
                  <optgroup label="Departments">
                    {authoring.destinations.departments.map((d) => (
                      <option key={d.departmentId} value={`d:${d.departmentId}`}>
                        {d.label}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
                {authoring.destinations.teams.length ? (
                  <optgroup label="Teams">
                    {authoring.destinations.teams.map((t) => (
                      <option key={t.teamId} value={`t:${t.teamId}`}>
                        {t.label}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
              </select>
              <p id="pref-home-hint" className="text-sm text-muted">
                Only departments and teams you belong to are listed.
              </p>
            </div>
            <Textarea
              id="pref-style"
              name="style"
              label="Preferred briefing style"
              hint="Optional guidance for your LLM, e.g. “Lead with the decision; keep sections short.”"
              defaultValue={prefs.preferredStyle ?? ""}
              maxLength={500}
              rows={3}
            />
          </ActionForm>
        </Card>
      </section>
    </PageContainer>
  );
}
