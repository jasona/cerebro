"use client";

import { useId, useSyncExternalStore } from "react";
import { cn } from "@cerebro/ui";
import { THEME_STORAGE_KEY, type ThemePreference } from "@/lib/theme";

const OPTIONS: Array<{ value: ThemePreference; label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

const listeners = new Set<() => void>();

function readPreference(): ThemePreference {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

function applyPreference(theme: ThemePreference) {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

function setPreference(theme: ThemePreference) {
  try {
    if (theme === "system") localStorage.removeItem(THEME_STORAGE_KEY);
    else localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // storage unavailable (private mode): still apply for this page view
  }
  applyPreference(theme);
  for (const listener of listeners) listener();
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  // Keep other tabs in step.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== THEME_STORAGE_KEY) return;
    applyPreference(readPreference());
    onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

/** System / Light / Dark segmented radio group. Saved per browser. */
export function ThemeSwitch({ className }: { className?: string }) {
  const theme = useSyncExternalStore(subscribe, readPreference, () => "system" as const);
  const name = useId();
  return (
    <fieldset className={className}>
      <legend className="mb-1.5 text-xs font-medium text-muted">Theme</legend>
      <div className="grid grid-cols-3 gap-0.5 rounded-md bg-subtle p-0.5">
        {OPTIONS.map((option) => (
          <label
            key={option.value}
            className={cn(
              "cursor-pointer rounded px-2 py-1 text-center text-sm text-fg has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-1 has-[:focus-visible]:outline-focus",
              theme === option.value && "bg-surface font-medium text-ink shadow-raised",
            )}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={theme === option.value}
              onChange={() => setPreference(option.value)}
              className="sr-only"
            />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
