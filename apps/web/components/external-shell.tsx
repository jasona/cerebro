"use client";

import { useSelectedLayoutSegment } from "next/navigation";
import type { ReactNode } from "react";
import { MinimalShell } from "./chrome";

/**
 * Minimal chrome for non-members under `/c/[company]/**` (external readers
 * with a briefing grant, D04). Briefing routes (segment `b`) get the
 * full-width variant so the reader's own column layout applies; everything
 * else (404s, workspace pages they cannot use) stays narrow and wide.
 */
export function ExternalShell({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  const segment = useSelectedLayoutSegment();
  return (
    <MinimalShell wide full={segment === "b"} actions={actions}>
      {children}
    </MinimalShell>
  );
}
