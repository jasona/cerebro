"use client";

import { useFormStatus } from "react-dom";
import { Button, type ButtonSize, type ButtonVariant } from "@cerebro/ui";

/**
 * Submit button for plain server-action forms: shows a pending label and
 * ignores repeat clicks while the action runs. Optional confirmation prompt.
 */
export function SubmitButton({
  children,
  pendingLabel = "Working…",
  variant = "primary",
  size = "md",
  confirm,
  disabled,
  className,
  ariaLabel,
  name,
  value,
}: {
  children: React.ReactNode;
  pendingLabel?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  confirm?: string;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
  name?: string;
  value?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      variant={variant}
      size={size}
      className={className}
      aria-label={ariaLabel}
      name={name}
      value={value}
      disabled={disabled}
      aria-disabled={pending || undefined}
      onClick={(e) => {
        if (pending) {
          e.preventDefault();
          return;
        }
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {pending ? pendingLabel : children}
    </Button>
  );
}
