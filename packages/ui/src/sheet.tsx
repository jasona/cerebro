"use client";

import * as Dialog from "@radix-ui/react-dialog";
import type { ReactNode } from "react";
import { cn } from "./cn";
import { focusRing } from "./primitives";

export interface SheetProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Element that opens the sheet; focus returns to it on close. Rendered with asChild. */
  trigger?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Visually hide the title (it is still announced). */
  hideTitle?: boolean;
  /** Desktop edge. Below the md breakpoint the sheet is always a bottom sheet. */
  side?: "right" | "left";
  closeLabel?: string;
  className?: string;
  children: ReactNode;
}

/**
 * Focused panel: a side panel on desktop, a bottom sheet on mobile.
 * Radix traps focus while open and restores it to the trigger on close.
 */
export function Sheet({
  open,
  defaultOpen,
  onOpenChange,
  trigger,
  title,
  description,
  hideTitle,
  side = "right",
  closeLabel = "Close",
  className,
  children,
}: SheetProps) {
  return (
    <Dialog.Root open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange}>
      {trigger ? <Dialog.Trigger asChild>{trigger}</Dialog.Trigger> : null}
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-scrim transition-opacity duration-(--cb-duration-base) data-[state=closed]:opacity-0" />
        <Dialog.Content
          {...(description ? {} : { "aria-describedby": undefined })}
          className={cn(
            "fixed z-50 flex flex-col bg-surface text-fg shadow-overlay outline-none",
            "inset-x-0 bottom-0 max-h-[85dvh] rounded-t-xl border-t border-line",
            "md:inset-y-0 md:bottom-auto md:h-dvh md:max-h-none md:w-panel md:max-w-[100vw] md:rounded-none md:border-t-0",
            side === "right" ? "md:right-0 md:left-auto md:border-l" : "md:left-0 md:right-auto md:border-r",
            className,
          )}
        >
          <div aria-hidden="true" className="mx-auto mt-2 h-1 w-10 rounded-pill bg-line md:hidden" />
          <header className="flex items-start justify-between gap-4 px-5 pt-4 pb-2 md:pt-6">
            <div>
              <Dialog.Title className={cn("font-serif text-title text-ink", hideTitle && "sr-only")}>{title}</Dialog.Title>
              {description ? <Dialog.Description className="mt-1 text-sm text-muted">{description}</Dialog.Description> : null}
            </div>
            <Dialog.Close className={cn("-mr-2 rounded-md p-2 text-muted hover:bg-subtle hover:text-ink", focusRing)} aria-label={closeLabel}>
              <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" strokeLinecap="round" />
              </svg>
            </Dialog.Close>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export const SheetClose = Dialog.Close;
