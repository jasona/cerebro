"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button, cn, focusRing, Sheet, Tabs, TabsContent, TabsList, TabsTrigger } from "@cerebro/ui";
import { AskPanel, EMPTY_CONVERSATION, type AskPanelProps, type Conversation } from "./ask-panel";
import { track, type TrackTarget } from "./track";

type Tab = "ask" | "evidence";

export interface ExplorePanelProps extends Omit<AskPanelProps, "conversation" | "setConversation" | "inputRef"> {
  /** Server-rendered evidence package (EvidenceList) for this revision. */
  evidence: ReactNode;
  evidenceCount: number;
  /** Measured-event context. */
  target: TrackTarget;
  /** Perspective selected on load (recorded once as perspective_select). */
  perspectiveId?: string;
  /** Hide the Ask tab (e.g. no read on Q&A); evidence remains. */
  askEnabled?: boolean;
}

const DESKTOP_QUERY = "(min-width: 80rem)"; // Tailwind xl

function useIsDesktop(): boolean {
  const [desktop, setDesktop] = useState(true);
  useEffect(() => {
    const mq = window.matchMedia(DESKTOP_QUERY);
    const update = () => setDesktop(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return desktop;
}

/**
 * "Explore this briefing": Ask and Evidence tabs. A sticky right panel on
 * wide screens; on smaller screens a bottom bar opens the same content in a
 * focused sheet, and closing it returns focus to where the reader was.
 *
 * Evidence markers (`#evidence-…` links anywhere on the page) switch to the
 * Evidence tab and bring the excerpt into view. `?ask=blk_…` (from "Ask about
 * this") switches to Ask and focuses the question box.
 */
export function ExplorePanel(props: ExplorePanelProps) {
  const { evidence, evidenceCount, target, perspectiveId, askEnabled = true, focus } = props;
  const desktop = useIsDesktop();
  const [tab, setTab] = useState<Tab>(askEnabled ? "ask" : "evidence");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [conversation, setConversation] = useState<Conversation>(EMPTY_CONVERSATION);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const desktopRef = useRef<HTMLDivElement | null>(null);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const pendingScroll = useRef<string | null>(null);

  // Measured events: open (once per mount/revision) and the initial perspective.
  useEffect(() => {
    track(target, "open");
  }, [target.briefingId, target.revisionNumber]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (perspectiveId) track(target, "perspective_select", perspectiveId);
  }, [perspectiveId, target.briefingId, target.revisionNumber]); // eslint-disable-line react-hooks/exhaustive-deps

  const scrollToEvidence = useCallback(() => {
    const id = pendingScroll.current;
    if (!id) return;
    const root = desktop ? desktopRef.current : sheetRef.current;
    const el = root?.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`);
    if (!el) return;
    pendingScroll.current = null;
    el.scrollIntoView({ block: "start", behavior: "smooth" });
    if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
    el.focus({ preventScroll: true });
  }, [desktop]);

  const openEvidence = useCallback(
    (anchorId: string, origin: HTMLElement | null) => {
      pendingScroll.current = anchorId;
      setTab("evidence");
      if (!desktop) {
        returnFocus.current = origin;
        setSheetOpen(true);
      }
      // Wait for the tab/sheet to render.
      requestAnimationFrame(() => requestAnimationFrame(scrollToEvidence));
      setTimeout(scrollToEvidence, 250);
    },
    [desktop, scrollToEvidence],
  );

  // Delegate evidence-marker clicks for the whole page (narrative, answers, outline).
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]");
      if (!(a instanceof HTMLAnchorElement)) return;
      const href = a.getAttribute("href") ?? "";
      const hash = href.startsWith("#") ? href.slice(1) : "";
      if (!hash.startsWith("evidence-")) return;
      e.preventDefault();
      history.replaceState(null, "", `#${hash}`);
      track(target, "evidence_open", hash.slice("evidence-".length));
      openEvidence(hash, a);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [openEvidence, target]);

  // Deep link: #evidence-… on load.
  useEffect(() => {
    const hash = decodeURIComponent(window.location.hash.slice(1));
    if (hash.startsWith("evidence-")) openEvidence(hash, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // "Ask about this": switch to Ask and focus the input.
  const focusId = focus?.id;
  useEffect(() => {
    if (!focusId) return;
    setTab("ask");
    if (!desktop) setSheetOpen(true);
    // The Ask tab (and on mobile the sheet) mounts after this render; retry briefly until the input exists.
    let tries = 0;
    let t: ReturnType<typeof setTimeout>;
    const tryFocus = () => {
      const el = inputRef.current;
      if (el && document.activeElement !== el) el.focus();
      if ((!el || document.activeElement !== el) && tries++ < 10) t = setTimeout(tryFocus, 60);
    };
    t = setTimeout(tryFocus, desktop ? 30 : 200);
    return () => clearTimeout(t);
  }, [focusId, desktop]);

  const onSheetChange = (open: boolean) => {
    setSheetOpen(open);
    if (!open) {
      const el = returnFocus.current;
      returnFocus.current = null;
      if (el) setTimeout(() => el.focus(), 50);
    }
  };

  const tabs = (idPrefix: string) => (
    <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="min-h-0 flex-1">
      <TabsList aria-label="Explore this briefing">
        {askEnabled ? (
          <TabsTrigger value="ask" id={`${idPrefix}-ask-tab`}>
            Ask
          </TabsTrigger>
        ) : null}
        <TabsTrigger value="evidence" id={`${idPrefix}-evidence-tab`}>
          Evidence{evidenceCount ? <span className="ml-1 text-muted">({evidenceCount})</span> : null}
        </TabsTrigger>
      </TabsList>
      {askEnabled ? (
        <TabsContent value="ask" className="pt-5">
          <AskPanel {...props} conversation={conversation} setConversation={setConversation} inputRef={inputRef} />
        </TabsContent>
      ) : null}
      <TabsContent value="evidence" className="pt-5">
        {evidence}
      </TabsContent>
    </Tabs>
  );

  return (
    <>
      {desktop ? (
        <aside
          id="explore"
          aria-labelledby="explore-title"
          className="sticky top-16 hidden h-[calc(100dvh-4rem)] w-panel shrink-0 flex-col self-start border-l border-line bg-paper xl:flex"
        >
          <div ref={desktopRef} className="min-h-0 flex-1 overflow-y-auto px-6 py-8">
            <h2 id="explore-title" className="font-serif text-title text-ink">
              Explore this briefing
            </h2>
            <div className="mt-4">{tabs("explore")}</div>
          </div>
        </aside>
      ) : (
        <>
          <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-paper/95 px-4 py-3 backdrop-blur xl:hidden">
            <div className="mx-auto flex max-w-xl gap-2">
              {askEnabled ? (
                <Button
                  variant="secondary"
                  className="flex-1"
                  onClick={(e) => {
                    returnFocus.current = e.currentTarget;
                    setTab("ask");
                    setSheetOpen(true);
                  }}
                >
                  Ask
                </Button>
              ) : null}
              <Button
                variant="secondary"
                className="flex-1"
                onClick={(e) => {
                  returnFocus.current = e.currentTarget;
                  setTab("evidence");
                  setSheetOpen(true);
                }}
              >
                Evidence{evidenceCount ? ` (${evidenceCount})` : ""}
              </Button>
            </div>
          </div>
          <Sheet open={sheetOpen} onOpenChange={onSheetChange} title="Explore this briefing" closeLabel="Close and return to the briefing">
            <div ref={sheetRef}>
              {tabs("sheet")}
              <div className="mt-8 border-t border-line pt-4">
                <button
                  type="button"
                  onClick={() => onSheetChange(false)}
                  className={cn("text-sm font-medium text-accent underline underline-offset-2", focusRing)}
                >
                  ← Back to the briefing
                </button>
              </div>
            </div>
          </Sheet>
        </>
      )}
    </>
  );
}
