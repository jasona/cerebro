import type { ReactNode } from "react";
import { getOrgTree, listMyCompanies } from "@cerebro/domain";
import { ExternalShell } from "@/components/external-shell";
import { Rail } from "@/components/workspace/rail";
import { SearchBox, UserMenu } from "@/components/workspace/top-bar";
import { WorkspaceShell, type DepartmentCrumbMap } from "@/components/workspace/workspace-shell";
import { requireUser } from "@/lib/auth";
import { getOptionalWorkspaceContext } from "@/lib/context";

export const dynamic = "force-dynamic";

/**
 * Wraps every `/c/[company]/**` route.
 *
 * Members get the workspace shell (rail collapses automatically on the
 * reader, segment `b`). Non-members get minimal chrome with no company
 * navigation or directory (full width on briefing routes); the page itself then decides: workspace pages call
 * getRequestContext (404), briefing pages call getBriefingRequestContext
 * (external reader grants, D04).
 */
export default async function CompanyLayout({ children, params }: { children: ReactNode; params: Promise<{ company: string }> }) {
  const { company } = await params;
  const user = await requireUser(`/c/${encodeURIComponent(company)}`);
  const ws = await getOptionalWorkspaceContext(company);

  if (!ws) {
    return <ExternalShell actions={<UserMenu name={user.name} email={user.email} />}>{children}</ExternalShell>;
  }

  const [companies, tree] = await Promise.all([listMyCompanies(ws.db, ws.user.userId), getOrgTree(ws.db, ws.ctx)]);
  const departments = tree.departments
    .filter((d) => !d.archivedAt)
    .map((d) => ({
      id: d.id,
      slug: d.slug,
      name: d.name,
      teams: d.teams.filter((t) => !t.archivedAt).map((t) => ({ id: t.id, slug: t.slug, name: t.name })),
    }));
  const crumbMap: DepartmentCrumbMap = Object.fromEntries(
    tree.departments.map((d) => [d.slug, { name: d.name, teams: Object.fromEntries(d.teams.map((t) => [t.slug, t.name])) }]),
  );
  const current = { slug: ws.org.slug, name: ws.org.name, role: ws.membership.role };

  return (
    <WorkspaceShell
      companySlug={ws.org.slug}
      companyName={ws.org.name}
      tree={crumbMap}
      rail={
        <Rail
          current={current}
          companies={companies.map((c) => ({ slug: c.slug, name: c.name, role: c.role }))}
          departments={departments}
          isAdmin={ws.isAdmin}
        />
      }
      topBarEnd={
        <>
          <SearchBox companySlug={ws.org.slug} />
          <UserMenu name={ws.user.name} email={ws.user.email} companySlug={ws.org.slug} />
        </>
      }
    >
      {children}
    </WorkspaceShell>
  );
}
