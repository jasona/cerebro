/**
 * Measured reader events (open, perspective_select, evidence_open). Fire and
 * forget: failures are silent and never affect reading. The server attaches a
 * pseudonymous session key cookie; no content is sent.
 */
export type TrackedEvent = "open" | "perspective_select" | "evidence_open" | "section_view";

export interface TrackTarget {
  company: string;
  briefing: string;
  briefingId: string;
  revisionNumber: number;
}

const ENDPOINT = "/api/briefings/events";

export function track(target: TrackTarget, type: TrackedEvent, blockId?: string): void {
  try {
    const body = JSON.stringify({ ...target, type, ...(blockId ? { blockId } : {}) });
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      if (navigator.sendBeacon(ENDPOINT, new Blob([body], { type: "application/json" }))) return;
    }
    void fetch(ENDPOINT, { method: "POST", body, keepalive: true, headers: { "content-type": "application/json" } }).catch(() => {});
  } catch {
    // Engagement is best-effort.
  }
}
