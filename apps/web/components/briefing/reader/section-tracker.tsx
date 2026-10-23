"use client";

import { useEffect } from "react";
import { track, type TrackTarget } from "./track";

const STORAGE_KEY = "cb_section_views";

/** Sections already reported in this browser session (survives client navigations and reloads). */
function seenSet(): Set<string> {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function remember(seen: Set<string>) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...seen].slice(-500)));
  } catch {
    // Storage may be unavailable (private mode); in-memory dedupe still applies.
  }
}

/**
 * Records one `section_view` per section per session when at least a third of
 * the section (or most of the viewport) has been on screen. Measures presence
 * only, never comprehension. Silent on failure; renders nothing. The server
 * also dedupes per pseudonymous session.
 */
export function SectionViewTracker({ target, sectionIds }: { target: TrackTarget; sectionIds: string[] }) {
  const ids = sectionIds.join("|");
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined" || !ids) return;
    let observer: IntersectionObserver | undefined;
    try {
      const seen = seenSet();
      const keyOf = (id: string) => `${target.briefingId}:${target.revisionNumber}:${id}`;
      const els = ids
        .split("|")
        .filter((id) => !seen.has(keyOf(id)))
        .map((id) => document.getElementById(id))
        .filter((el): el is HTMLElement => el !== null);
      if (!els.length) return;
      observer = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            const coversViewport = e.intersectionRect.height >= window.innerHeight * 0.5;
            if (!e.isIntersecting || (e.intersectionRatio < 0.33 && !coversViewport)) continue;
            const id = (e.target as HTMLElement).id;
            observer?.unobserve(e.target);
            if (seen.has(keyOf(id))) continue;
            seen.add(keyOf(id));
            remember(seen);
            track(target, "section_view", id);
          }
        },
        { threshold: [0, 0.33, 0.66, 1] },
      );
      for (const el of els) observer.observe(el);
    } catch {
      // Engagement is best-effort.
    }
    return () => observer?.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, target.briefingId, target.revisionNumber]);
  return null;
}
