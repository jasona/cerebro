import type { DomainErrorCode } from "@cerebro/domain";

/** Result returned by server actions used with <ActionForm> / useActionState. */
export type ActionState =
  | { status: "idle" }
  | { status: "ok"; message?: string; secret?: { label: string; value: string; hint?: string } }
  | { status: "error"; code: DomainErrorCode | "unknown"; message: string; details?: SafeErrorDetails };

/**
 * The only domain error details passed back to the browser: validation
 * issues (path + message), the current draft version on a conflict, and
 * machine-readable reason codes. Everything else in `DomainError.details` is
 * dropped.
 */
export interface SafeErrorDetails {
  issues?: { path?: string; message: string }[];
  currentVersion?: number;
  reasons?: string[];
}

export const IDLE: ActionState = { status: "idle" };

export type FormAction = (prev: ActionState, formData: FormData) => Promise<ActionState>;
