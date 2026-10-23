import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import { cn } from "./cn";

/* Server-compatible primitives: no hooks, no event wiring of their own. */

export const focusRing =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const buttonVariants: Record<ButtonVariant, string> = {
  primary: "bg-accent text-on-accent hover:bg-accent-hover",
  secondary: "border border-line-strong bg-surface text-ink hover:bg-subtle",
  ghost: "text-fg hover:bg-subtle",
  danger: "bg-danger text-on-danger hover:opacity-90",
};

const buttonSizes: Record<ButtonSize, string> = {
  sm: "min-h-8 px-3 text-sm gap-1.5",
  md: "min-h-10 px-4 text-sm gap-2",
  lg: "min-h-12 px-5 text-base gap-2",
};

/** Class string for button-styled elements (e.g. a Next <Link>). */
export function buttonClasses({ variant = "primary", size = "md", className }: { variant?: ButtonVariant; size?: ButtonSize; className?: string } = {}) {
  return cn(
    "inline-flex items-center justify-center rounded-md font-sans font-medium leading-none",
    "transition-colors duration-(--cb-duration-fast) ease-standard",
    "disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50",
    focusRing,
    buttonVariants[variant],
    buttonSizes[size],
    className,
  );
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function Button({ variant, size, className, type = "button", ...props }: ButtonProps) {
  return <button type={type} className={buttonClasses({ variant, size, className })} {...props} />;
}

export type Tone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";

const toneClasses: Record<Tone, string> = {
  neutral: "bg-subtle text-fg",
  accent: "bg-accent-soft text-accent-ink",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
  info: "bg-info-soft text-info",
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
}

export function Badge({ tone = "neutral", className, ...props }: BadgeProps) {
  return (
    <span
      className={cn("inline-flex items-center gap-1 rounded-pill px-2.5 py-0.5 text-xs font-medium", toneClasses[tone], className)}
      {...props}
    />
  );
}

export type PublicationStatus = "published" | "draft" | "withdrawn" | "scheduled" | "superseded";

const statusMeta: Record<PublicationStatus, { label: string; tone: Tone }> = {
  published: { label: "Published", tone: "success" },
  draft: { label: "Draft", tone: "neutral" },
  withdrawn: { label: "Withdrawn", tone: "danger" },
  scheduled: { label: "Scheduled", tone: "info" },
  superseded: { label: "Superseded", tone: "warning" },
};

export interface StatusPillProps extends HTMLAttributes<HTMLSpanElement> {
  status: PublicationStatus;
  /** Overrides the default label, e.g. "Published · v3". */
  label?: string;
}

/** Publication state. The dot is decorative; the label carries the meaning. */
export function StatusPill({ status, label, className, ...props }: StatusPillProps) {
  const meta = statusMeta[status];
  return (
    <Badge tone={meta.tone} className={className} {...props}>
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {label ?? meta.label}
    </Badge>
  );
}

export interface CardProps extends HTMLAttributes<HTMLElement> {
  as?: "div" | "section" | "article" | "aside" | "li";
  tone?: "surface" | "accent" | "subtle";
}

export function Card({ as: Tag = "div", tone = "surface", className, ...props }: CardProps) {
  return (
    <Tag
      className={cn(
        "rounded-lg border p-5",
        tone === "surface" && "border-line bg-surface",
        tone === "subtle" && "border-line bg-subtle",
        tone === "accent" && "border-accent/25 bg-accent-soft text-accent-ink",
        className,
      )}
      {...props}
    />
  );
}

export function VisuallyHidden({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn("sr-only", className)} {...props} />;
}

export interface EmptyStateProps {
  title: string;
  description?: ReactNode;
  icon?: ReactNode;
  /** Primary next step, e.g. a "New brief" button or link. */
  action?: ReactNode;
  headingLevel?: 2 | 3 | 4;
  className?: string;
}

export function EmptyState({ title, description, icon, action, headingLevel = 2, className }: EmptyStateProps) {
  const Heading = `h${headingLevel}` as const;
  return (
    <div className={cn("flex flex-col items-center rounded-lg border border-dashed border-line px-6 py-10 text-center", className)}>
      {icon ? (
        <div aria-hidden="true" className="mb-3 text-muted">
          {icon}
        </div>
      ) : null}
      <Heading className="font-serif text-title text-ink">{title}</Heading>
      {description ? <div className="mt-2 max-w-md text-sm text-muted">{description}</div> : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}
