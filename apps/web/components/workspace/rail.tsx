import { ClockIcon, DocumentIcon, GearIcon, PencilIcon, PeopleIcon, ShieldIcon } from "../icons";
import { Logo } from "../chrome";
import { CompanySwitcher, type SwitcherCompany } from "./company-switcher";
import { NavLink } from "./nav-link";
import { OrgTree, type TreeDepartment } from "./org-tree";

export interface RailProps {
  current: SwitcherCompany;
  companies: SwitcherCompany[];
  departments: TreeDepartment[];
  isAdmin: boolean;
}

/** Workspace rail: company switcher, library views, org tree, people, settings, admin. */
export function Rail({ current, companies, departments, isAdmin }: RailProps) {
  const base = `/c/${encodeURIComponent(current.slug)}`;
  return (
    <div className="flex min-h-full flex-col gap-5 px-4 py-5">
      <Logo href={base} className="px-2" />
      <CompanySwitcher current={current} companies={companies} />

      <nav aria-label="Library">
        <ul className="flex flex-col gap-0.5">
          <li>
            <NavLink href={base} icon={<DocumentIcon />}>
              All briefs
            </NavLink>
          </li>
          <li>
            <NavLink href={`${base}/recent`} icon={<ClockIcon />}>
              Recently updated
            </NavLink>
          </li>
          <li>
            <NavLink href={`${base}/drafts`} icon={<PencilIcon />}>
              My drafts
            </NavLink>
          </li>
        </ul>
      </nav>

      <nav aria-labelledby="rail-tree-heading" className="border-t border-line pt-5">
        <h2 id="rail-tree-heading" className="mb-2 px-3 text-[0.6875rem] font-medium tracking-wider text-muted uppercase">
          Departments &amp; teams
        </h2>
        <OrgTree companySlug={current.slug} departments={departments} />
      </nav>

      <nav aria-label="Company" className="mt-auto border-t border-line pt-5">
        <ul className="flex flex-col gap-0.5">
          <li>
            <NavLink href={`${base}/people`} icon={<PeopleIcon />} matchPrefix>
              People
            </NavLink>
          </li>
          <li>
            <NavLink href={`${base}/settings`} icon={<GearIcon />}>
              Settings
            </NavLink>
          </li>
          {isAdmin ? (
            <li>
              <NavLink href={`${base}/admin`} icon={<ShieldIcon />}>
                Company admin
              </NavLink>
            </li>
          ) : null}
        </ul>
      </nav>
    </div>
  );
}
