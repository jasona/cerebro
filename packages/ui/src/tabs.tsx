"use client";

import * as RadixTabs from "@radix-ui/react-tabs";
import type { ComponentPropsWithoutRef } from "react";
import { cn } from "./cn";
import { focusRing } from "./primitives";

/** Radix tabs (arrow-key navigation, roving focus) styled as underlined text tabs. */
export function Tabs({ className, ...props }: ComponentPropsWithoutRef<typeof RadixTabs.Root>) {
  return <RadixTabs.Root className={cn("flex flex-col", className)} {...props} />;
}

export function TabsList({ className, ...props }: ComponentPropsWithoutRef<typeof RadixTabs.List>) {
  return <RadixTabs.List className={cn("flex gap-6 border-b border-line", className)} {...props} />;
}

export function TabsTrigger({ className, ...props }: ComponentPropsWithoutRef<typeof RadixTabs.Trigger>) {
  return (
    <RadixTabs.Trigger
      className={cn(
        "-mb-px border-b-2 border-transparent py-2 text-sm font-medium text-muted hover:text-ink",
        "data-[state=active]:border-accent data-[state=active]:text-ink",
        focusRing,
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: ComponentPropsWithoutRef<typeof RadixTabs.Content>) {
  return <RadixTabs.Content className={cn("pt-4", focusRing, className)} {...props} />;
}
