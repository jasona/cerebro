import type { SVGProps } from "react";

/* Decorative 16/20px stroke icons. Always aria-hidden; meaning lives in text. */
type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 18, children, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {children}
    </svg>
  );
}

export const DocumentIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 2.5h6.5L15 6v11.5H5z" />
    <path d="M11.5 2.5V6H15M7.5 10h5M7.5 13h5" />
  </Svg>
);
export const ClockIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="10" cy="10" r="7.5" />
    <path d="M10 5.5V10l3 2" />
  </Svg>
);
export const PencilIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13.5 3.5l3 3L7 16H4v-3z" />
  </Svg>
);
export const PeopleIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="7.5" cy="7" r="2.75" />
    <path d="M2.5 16c.5-2.75 2.5-4.25 5-4.25s4.5 1.5 5 4.25" />
    <circle cx="14" cy="7.5" r="2.25" />
    <path d="M13.5 11.75c2 .1 3.5 1.4 4 3.75" />
  </Svg>
);
export const GearIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="10" cy="10" r="2.5" />
    <path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" />
  </Svg>
);
export const ShieldIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10 2.5l6 2.5v4.5c0 4-2.75 6.5-6 8-3.25-1.5-6-4-6-8V5z" />
  </Svg>
);
export const FolderIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.5 5.5h5l1.5 2h8.5v8h-15z" />
  </Svg>
);
export const ChevronIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7.5 5l5 5-5 5" />
  </Svg>
);
export const ChevronDownIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 7.5l5 5 5-5" />
  </Svg>
);
export const SearchIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="9" cy="9" r="5.5" />
    <path d="M13 13l4 4" />
  </Svg>
);
export const PlusIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10 4v12M4 10h12" />
  </Svg>
);
export const MenuIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 5.5h14M3 10h14M3 14.5h14" />
  </Svg>
);
export const BuildingIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 17.5V3.5h8v14M12 8h4v9.5M2.5 17.5h15M6.5 6.5h1M9 6.5h1M6.5 9.5h1M9 9.5h1M6.5 12.5h1M9 12.5h1" />
  </Svg>
);
export const ArrowUpRightIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 14L14 6M7.5 6H14v6.5" />
  </Svg>
);

export function CerebroMark({ size = 28 }: { size?: number }) {
  return (
    <svg aria-hidden="true" focusable="false" width={size} height={size} viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="16" cy="16" r="14" />
      <circle cx="16" cy="16" r="9.5" />
      <circle cx="16" cy="16" r="5" />
    </svg>
  );
}
