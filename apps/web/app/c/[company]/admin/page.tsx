import type { Metadata } from "next";
import Link from "next/link";
import { getOrgTree, isDomainError, listInvitations, listMembers, previewTeamReparent } from "@cerebro/domain";
import { cn, EmptyState, focusRing } from "@cerebro/ui";
import { InvitationsSection } from "@/components/admin/invitations-section";
import { MembersSection } from "@/components/admin/members-section";
import { StructureSection, type ReparentPreview } from "@/components/admin/structure-section";
import { PageContainer, PageHeader } from "@/components/library/page-header";
import { getRequestContext } from "@/lib/context";
import { errorMessage, loadOrThrow } from "@/lib/errors";
import { paths } from "@/lib/paths";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Company admin" };

const TABS = [
  { key: "structure", label: "Departments & teams" },
  { key: "members", label: "Members" },
  { key: "invitations", label: "Invitations" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

const NOTICES: Record<string, string> = { moved: "Team moved. The change is audited and takes effect immediately." };

export default async function AdminPage({
  params,
  searchParams,
}: {
  params: Promise<{ company: string }>;
  searchParams: Promise<{ tab?: string; reparent?: string; to?: string; notice?: string }>;
}) {
  const { company } = await params;
  const sp = await searchParams;
  const ws = await getRequestContext(company);
  const slug = ws.org.slug;

  if (!ws.isAdmin) {
    return (
      <PageContainer width="narrow">
        <PageHeader title="Company admin" size="headline" />
        <EmptyState
          className="mt-8"
          title="Admins only"
          description="Company owners and admins manage departments, teams, members and invitations. Ask an admin if something needs to change."
        />
      </PageContainer>
    );
  }

  const tab: TabKey = TABS.some((t) => t.key === sp.tab) ? (sp.tab as TabKey) : "structure";
  const tree = await loadOrThrow(() => getOrgTree(ws.db, ws.ctx, { includeArchived: true }));
  let body;

  if (tab === "structure") {
    let preview: ReparentPreview | null = null;
    let previewError: string | null = null;
    if (sp.reparent && sp.to) {
      try {
        const impact = await previewTeamReparent(ws.db, ws.ctx, { teamId: sp.reparent, newDepartmentId: sp.to });
        const name = (id: string) => tree.departments.find((d) => d.id === id)?.name ?? "department";
        const team = tree.departments.flatMap((d) => d.teams).find((t) => t.id === impact.teamId);
        preview = { teamName: team?.name ?? "team", fromName: name(impact.fromDepartmentId), toName: name(impact.toDepartmentId), impact };
      } catch (err) {
        if (!isDomainError(err)) throw err;
        previewError = err.code === "validation" ? err.message : errorMessage(err.code);
      }
    }
    body = <StructureSection company={slug} tree={tree} preview={preview} previewError={previewError} />;
  } else if (tab === "members") {
    const members = await loadOrThrow(() => listMembers(ws.db, ws.ctx));
    body = (
      <MembersSection company={slug} members={members} tree={tree} viewerUserId={ws.user.userId} viewerIsOwner={ws.membership.role === "owner"} />
    );
  } else {
    const invitations = await loadOrThrow(() => listInvitations(ws.db, ws.ctx));
    body = <InvitationsSection company={slug} invitations={invitations} viewerIsOwner={ws.membership.role === "owner"} />;
  }

  return (
    <PageContainer width="narrow">
      <PageHeader eyebrow={`${ws.org.name} / Company admin`} title="Company admin" size="headline" description="Structure, membership and invitations." />
      {sp.notice && NOTICES[sp.notice] ? (
        <p role="status" className="mt-6 rounded-md bg-success-soft px-4 py-3 text-sm text-success">
          {NOTICES[sp.notice]}
        </p>
      ) : null}
      <nav aria-label="Admin sections" className="mt-8 mb-6 border-b border-line">
        <ul className="-mb-px flex flex-wrap gap-1">
          {TABS.map((t) => (
            <li key={t.key}>
              <Link
                href={paths.admin(slug, { tab: t.key })}
                aria-current={tab === t.key ? "page" : undefined}
                className={cn(
                  "inline-flex min-h-10 items-center border-b-2 px-3 text-sm font-medium",
                  tab === t.key ? "border-accent text-accent-ink" : "border-transparent text-muted hover:text-ink",
                  focusRing,
                )}
              >
                {t.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      {body}
    </PageContainer>
  );
}
