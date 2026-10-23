"use client";

import { createContext, useContext, type ReactNode } from "react";
import { Button, cn } from "@cerebro/ui";

/** Announces structural edits ("Section moved up") to assistive tech. */
export const AnnounceContext = createContext<(message: string) => void>(() => {});
export const useAnnounce = () => useContext(AnnounceContext);

/** Move an item within an array (returns a new array). */
export function move<T>(list: readonly T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length) return [...list];
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

/** Re-focus a control after React reorders the DOM. */
export function focusSoon(id: string) {
  requestAnimationFrame(() => document.getElementById(id)?.focus());
}

/**
 * Keyboard-friendly reorder and delete buttons. Each button has a full
 * accessible name ("Move section “Why now” up"); focus follows the item.
 */
export function ItemControls({
  idBase,
  noun,
  name,
  index,
  count,
  onMove,
  onRemove,
  removeLabel = "Delete",
}: {
  idBase: string;
  noun: string;
  name: string;
  index: number;
  count: number;
  onMove: (to: number) => void;
  onRemove?: () => void;
  removeLabel?: string;
}) {
  const announce = useAnnounce();
  const label = name.trim() ? `${noun} “${name.trim().slice(0, 60)}”` : `${noun} ${index + 1}`;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1">
      <Button
        id={`${idBase}-up`}
        variant="ghost"
        size="sm"
        aria-label={`Move ${label} up`}
        aria-disabled={index === 0 || undefined}
        onClick={() => {
          if (index === 0) return;
          onMove(index - 1);
          announce(`${label} moved to position ${index} of ${count}.`);
          focusSoon(index - 1 === 0 ? `${idBase}-down` : `${idBase}-up`);
        }}
      >
        ↑<span className="sr-only">Up</span>
      </Button>
      <Button
        id={`${idBase}-down`}
        variant="ghost"
        size="sm"
        aria-label={`Move ${label} down`}
        aria-disabled={index === count - 1 || undefined}
        onClick={() => {
          if (index === count - 1) return;
          onMove(index + 1);
          announce(`${label} moved to position ${index + 2} of ${count}.`);
          focusSoon(index + 1 === count - 1 ? `${idBase}-up` : `${idBase}-down`);
        }}
      >
        ↓<span className="sr-only">Down</span>
      </Button>
      {onRemove ? (
        <Button
          variant="ghost"
          size="sm"
          className="text-danger"
          aria-label={`${removeLabel} ${label}`}
          onClick={() => {
            if (!window.confirm(`${removeLabel} ${label}? You can still discard unsaved changes by reloading.`)) return;
            onRemove();
            announce(`${label} deleted.`);
          }}
        >
          {removeLabel}
        </Button>
      ) : null}
    </div>
  );
}

/** A titled editor group (fieldset with legend). */
export function Group({ title, description, children, className, actions }: { title: string; description?: ReactNode; children: ReactNode; className?: string; actions?: ReactNode }) {
  return (
    <fieldset className={cn("rounded-lg border border-line bg-surface p-5", className)}>
      <legend className="sr-only">{title}</legend>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 aria-hidden="true" className="font-medium text-ink">
            {title}
          </h3>
          {description ? <p className="mt-0.5 text-sm text-muted">{description}</p> : null}
        </div>
        {actions}
      </div>
      <div className="flex flex-col gap-4">{children}</div>
    </fieldset>
  );
}
