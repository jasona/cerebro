import type { ReactNode } from "react";
import { cn, focusRing } from "@cerebro/ui";

/**
 * Two-step confirmation without client JS: a disclosure whose panel holds
 * the destructive form. The summary reads like a button.
 */
export function ConfirmDisclosure({ label, children, tone = "danger" }: { label: string; children: ReactNode; tone?: "danger" | "neutral" }) {
  return (
    <details className="group">
      <summary
        className={cn(
          "inline-flex min-h-8 cursor-pointer items-center rounded-md px-3 text-sm font-medium hover:bg-subtle",
          tone === "danger" ? "text-danger" : "text-fg",
          focusRing,
        )}
      >
        {label}
      </summary>
      <div className="mt-2 rounded-lg border border-line bg-surface p-4 shadow-raised">{children}</div>
    </details>
  );
}

export function Hidden({ fields }: { fields: Record<string, string> }) {
  return (
    <>
      {Object.entries(fields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
    </>
  );
}
