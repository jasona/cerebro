"use client";

import { useActionState, useEffect, useRef, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { Button, cn, type ButtonSize, type ButtonVariant } from "@cerebro/ui";
import { IDLE, type ActionState, type FormAction } from "@/lib/action-state";

export interface ActionFormProps {
  action: FormAction;
  children?: ReactNode;
  submitLabel: string;
  pendingLabel?: string;
  submitVariant?: ButtonVariant;
  submitSize?: ButtonSize;
  /** Accessible name for the submit when the visible label is ambiguous ("Remove"). */
  submitAriaLabel?: string;
  className?: string;
  /** Reset fields after success (e.g. create forms). */
  resetOnSuccess?: boolean;
  /** Inline layout: fields and button on one row. */
  inline?: boolean;
  /** Hide the success message (e.g. when the row will disappear). */
  quietSuccess?: boolean;
}

function Submit({ label, pendingLabel, variant, size, ariaLabel }: { label: string; pendingLabel?: string; variant?: ButtonVariant; size?: ButtonSize; ariaLabel?: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} size={size} aria-disabled={pending || undefined} aria-label={ariaLabel}>
      {pending ? (pendingLabel ?? "Working…") : label}
    </Button>
  );
}

/**
 * Form bound to a server action returning ActionState. Shows the mapped
 * DomainError message (role=alert) or a success status, and can reveal a
 * one-time secret (invitation link, connection token) returned by the action.
 */
export function ActionForm({
  action,
  children,
  submitLabel,
  pendingLabel,
  submitVariant = "primary",
  submitSize = "md",
  submitAriaLabel,
  className,
  resetOnSuccess,
  inline,
  quietSuccess,
}: ActionFormProps) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, IDLE);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.status === "ok" && resetOnSuccess) formRef.current?.reset();
  }, [state, resetOnSuccess]);

  return (
    <div className={className}>
      <form ref={formRef} action={formAction} className={cn(inline ? "flex flex-wrap items-end gap-2" : "flex flex-col gap-4")}>
        {children}
        <div>
          <Submit label={submitLabel} pendingLabel={pendingLabel} variant={submitVariant} size={submitSize} ariaLabel={submitAriaLabel} />
        </div>
      </form>
      <div aria-live="polite">
        {state.status === "error" ? (
          <p role="alert" className="mt-2 text-sm font-medium text-danger">
            {state.message}
          </p>
        ) : null}
        {state.status === "ok" && state.message && !quietSuccess && !state.secret ? (
          <p role="status" className="mt-2 text-sm text-success">
            {state.message}
          </p>
        ) : null}
      </div>
      {state.status === "ok" && state.secret ? <SecretReveal {...state.secret} message={state.message} /> : null}
    </div>
  );
}

/** One-time secret display with a copy button (falls back to manual select). */
export function SecretReveal({ label, value, hint, message }: { label: string; value: string; hint?: string; message?: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const statusRef = useRef<HTMLSpanElement>(null);
  return (
    <div role="status" className="mt-4 rounded-lg border border-warning/40 bg-warning-soft p-4">
      {message ? <p className="font-medium text-ink">{message}</p> : null}
      <label htmlFor="one-time-secret" className="mt-1 block text-sm font-medium text-ink">
        {label}
      </label>
      <div className="mt-2 flex flex-wrap gap-2">
        <input
          ref={inputRef}
          id="one-time-secret"
          readOnly
          value={value}
          onFocus={(e) => e.currentTarget.select()}
          className="min-w-0 flex-1 rounded-md border border-line-strong bg-surface px-3 py-2 font-mono text-sm text-ink"
        />
        <Button
          variant="secondary"
          onClick={async () => {
            inputRef.current?.select();
            try {
              await navigator.clipboard.writeText(value);
              if (statusRef.current) statusRef.current.textContent = "Copied.";
            } catch {
              if (statusRef.current) statusRef.current.textContent = "Copy failed; select the text and copy it manually.";
            }
          }}
        >
          Copy
        </Button>
      </div>
      <span ref={statusRef} aria-live="polite" className="mt-1 block text-sm text-muted" />
      {hint ? <p className="mt-2 text-sm text-warning">{hint}</p> : null}
    </div>
  );
}
