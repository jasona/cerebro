import type { Metadata } from "next";
import { getOrgTree } from "@cerebro/domain";
import { NewBriefForm } from "@/components/briefing/new-brief-form";
import { getRequestContext } from "@/lib/context";
import { loadOrThrow } from "@/lib/errors";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "New brief" };

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * New brief. The home is inherited from `?department=&team=` (slugs); the
 * audience is always chosen explicitly (default: the whole company) and
 * shown before anything is created.
 */
export default async function NewBriefPage({
  params,
  searchParams,
}: {
  params: Promise<{ company: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { company } = await params;
  const sp = await searchParams;
  const ws = await getRequestContext(decodeURIComponent(company));
  const tree = await loadOrThrow(() => getOrgTree(ws.db, ws.ctx));
  const departments = tree.departments.filter((d) => !d.archivedAt);
  const org = ws.org.name;

  const deptSlug = one(sp.department);
  const teamSlug = one(sp.team);
  const dept = departments.find((d) => d.slug === deptSlug);
  const team = dept?.teams.find((t) => t.slug === teamSlug && !t.archivedAt);
  const defaultHome = team ? `t:${team.id}` : dept ? `d:${dept.id}` : "";

  const homeOptions = [
    { value: "", label: org },
    ...departments.flatMap((d) => [
      { value: `d:${d.id}`, label: `${org} / ${d.name}` },
      ...d.teams.filter((t) => !t.archivedAt).map((t) => ({ value: `t:${t.id}`, label: `${org} / ${d.name} / ${t.name}` })),
    ]),
  ];
  const audienceOptions = [
    { value: "company", label: `Everyone at ${org} (company-wide)` },
    ...departments.flatMap((d) => [
      { value: `department:${d.id}`, label: `${d.name} department (including its teams)` },
      ...d.teams.filter((t) => !t.archivedAt).map((t) => ({ value: `team:${t.id}`, label: `${t.name} team (${d.name})` })),
    ]),
    { value: "restricted", label: "Named readers only (add people after creating)" },
  ];

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 lg:py-10">
      <p className="mb-3 text-xs font-medium tracking-[0.14em] text-muted uppercase">{org} / New brief</p>
      <h1 className="font-serif text-headline text-ink">Start a brief</h1>
      <p className="mt-3 max-w-2xl text-lg text-muted">
        You&apos;ll get a private draft to review and edit. Nothing is published until you choose Publish, and only evidence you approve is shown
        to readers.
      </p>
      <div className="mt-8">
        <NewBriefForm company={ws.org.slug} companyName={org} homeOptions={homeOptions} defaultHome={defaultHome} audienceOptions={audienceOptions} />
      </div>
    </div>
  );
}
