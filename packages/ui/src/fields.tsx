import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { cn } from "./cn";
import { focusRing } from "./primitives";

/*
 * Form fields. `id` is required so the label association is deterministic and
 * these stay server-component compatible (no useId).
 */

export interface FieldProps {
  /** id of the control; the label targets it. */
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  /** Keep the label for assistive tech but hide it visually. */
  hideLabel?: boolean;
  className?: string;
  children: ReactNode;
}

export function fieldDescribedBy(id: string, hint?: ReactNode, error?: ReactNode): string | undefined {
  const ids = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean);
  return ids.length ? ids.join(" ") : undefined;
}

export function Field({ id, label, hint, error, required, hideLabel, className, children }: FieldProps) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className={cn("text-sm font-medium text-ink", hideLabel && "sr-only")}>
        {label}
        {required ? (
          <span className="text-muted">
            <span aria-hidden="true"> *</span>
            <span className="sr-only"> (required)</span>
          </span>
        ) : null}
      </label>
      {children}
      {hint ? (
        <p id={`${id}-hint`} className="text-sm text-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

const control = cn(
  "w-full rounded-md border bg-surface px-3 py-2 text-base text-fg placeholder:text-muted",
  "disabled:cursor-not-allowed disabled:opacity-60",
  focusRing,
);

type Common = Omit<FieldProps, "children" | "className"> & { className?: string; fieldClassName?: string };

function controlProps(p: Common) {
  return {
    id: p.id,
    required: p.required,
    "aria-describedby": fieldDescribedBy(p.id, p.hint, p.error),
    "aria-invalid": p.error ? true : undefined,
    className: cn(control, p.error ? "border-danger" : "border-line-strong", p.className),
  } as const;
}

export type InputProps = Common & Omit<InputHTMLAttributes<HTMLInputElement>, "id" | "className" | "required">;

export function Input({ label, hint, error, hideLabel, fieldClassName, ...rest }: InputProps) {
  const { id, required, className, ...native } = rest;
  return (
    <Field id={id} label={label} hint={hint} error={error} required={required} hideLabel={hideLabel} className={fieldClassName}>
      <input {...native} {...controlProps({ id, label, hint, error, required, className })} />
    </Field>
  );
}

export type TextareaProps = Common & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "id" | "className" | "required">;

export function Textarea({ label, hint, error, hideLabel, fieldClassName, rows = 4, ...rest }: TextareaProps) {
  const { id, required, className, ...native } = rest;
  return (
    <Field id={id} label={label} hint={hint} error={error} required={required} hideLabel={hideLabel} className={fieldClassName}>
      <textarea rows={rows} {...native} {...controlProps({ id, label, hint, error, required, className })} />
    </Field>
  );
}

export type SelectProps = Common &
  Omit<SelectHTMLAttributes<HTMLSelectElement>, "id" | "className" | "required"> & {
    options?: Array<{ value: string; label: string; disabled?: boolean }>;
  };

export function Select({ label, hint, error, hideLabel, fieldClassName, options, children, ...rest }: SelectProps) {
  const { id, required, className, ...native } = rest;
  return (
    <Field id={id} label={label} hint={hint} error={error} required={required} hideLabel={hideLabel} className={fieldClassName}>
      <select {...native} {...controlProps({ id, label, hint, error, required, className: cn("pr-8", className) })}>
        {options?.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
        {children}
      </select>
    </Field>
  );
}
