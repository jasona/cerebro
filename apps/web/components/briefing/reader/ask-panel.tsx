"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { AskQuestionResult, ThreadDto } from "@cerebro/domain";
import { Button, cn, focusRing } from "@cerebro/ui";
import { askAction, sendQuestionToAuthorAction } from "@/app/c/[company]/b/[briefing]/actions";
import { formatDateTime } from "@/lib/format";
import { AnswerParts } from "./answer";
import type { TrackTarget } from "./track";

export interface Exchange {
  id: string;
  question: string;
  focusBlockId?: string;
  focusLabel?: string;
  pending: boolean;
  result?: AskQuestionResult;
  error?: string;
  note?: string;
}

export interface Conversation {
  threadId: string | null;
  exchanges: Exchange[];
}

export const EMPTY_CONVERSATION: Conversation = { threadId: null, exchanges: [] };

export interface AskPanelProps {
  target: TrackTarget;
  focus: { id: string; label: string } | null;
  perspective: { id: string; label: string } | null;
  /** The viewer's previous private threads on this revision. */
  threads: ThreadDto[];
  minCohort: number;
  /** Link that clears the block focus (keeps the perspective). */
  clearFocusHref: string;
  conversation: Conversation;
  setConversation: Dispatch<SetStateAction<Conversation>>;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}

let seq = 0;
const nextId = () => `x${++seq}`;

const STATUS_COPY: Record<Exclude<AskQuestionResult["status"], "answered">, { title: string; body: string }> = {
  preparing: {
    title: "Q&A is being prepared for this version",
    body: "Answers become available once this version has been indexed. You can keep reading; try again in a minute.",
  },
  insufficient: {
    title: "The briefing doesn't answer this",
    body: "This version and its approved evidence don't contain enough to answer.",
  },
  refused: {
    title: "This can't be answered from the briefing",
    body: "Questions are answered only from this version and its approved evidence.",
  },
  failed: {
    title: "Answers are unavailable right now",
    body: "The briefing and its evidence remain available to read.",
  },
};

function SendToAuthor({ target, exchange, threadId }: { target: TrackTarget; exchange: Exchange; threadId: string | null }) {
  const [state, setState] = useState<{ status: "idle" | "sending" | "sent" | "error"; message?: string }>({ status: "idle" });
  const [confirming, setConfirming] = useState(false);
  if (state.status === "sent") {
    return (
      <p role="status" className="mt-3 text-sm text-success">
        {state.message}
      </p>
    );
  }
  return (
    <div className="mt-3 rounded-md border border-line bg-paper p-3">
      {!confirming ? (
        <Button variant="secondary" size="sm" onClick={() => setConfirming(true)}>
          Send this question to the author
        </Button>
      ) : (
        <div>
          <p className="text-sm text-fg">
            The author will see this question with your name, for version {target.revisionNumber}. The answer and the rest of your
            conversation stay private.
          </p>
          <p className="mt-2 rounded-sm bg-subtle px-2 py-1 text-sm text-ink">“{exchange.question}”</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              size="sm"
              aria-disabled={state.status === "sending" || undefined}
              onClick={async () => {
                if (state.status === "sending") return;
                setState({ status: "sending" });
                const res = await sendQuestionToAuthorAction({
                  ...target,
                  text: exchange.question,
                  ...(exchange.focusBlockId ? { blockId: exchange.focusBlockId } : {}),
                  ...(threadId ? { fromThreadId: threadId } : {}),
                });
                setState(res.status === "ok" ? { status: "sent", message: res.message } : { status: "error", message: res.status === "error" ? res.message : "" });
              }}
            >
              {state.status === "sending" ? "Sending…" : "Send with my name"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {state.status === "error" ? (
        <p role="alert" className="mt-2 text-sm font-medium text-danger">
          {state.message}
        </p>
      ) : null}
    </div>
  );
}

function ExchangeView({ ex, target, threadId }: { ex: Exchange; target: TrackTarget; threadId: string | null }) {
  const r = ex.result;
  return (
    <li className="flex flex-col gap-3">
      {ex.focusLabel ? <p className="text-xs font-medium tracking-[0.12em] text-muted uppercase">About: {ex.focusLabel}</p> : null}
      <p className="self-start rounded-lg bg-accent-soft px-4 py-3 text-ink">{ex.question}</p>
      {ex.note ? <p className="text-sm text-muted">{ex.note}</p> : null}
      {ex.pending ? (
        <p role="status" className="text-sm text-muted">
          Finding an answer in version {target.revisionNumber}…
        </p>
      ) : ex.error ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {ex.error}
        </p>
      ) : r ? (
        r.status === "answered" ? (
          <div>
            <AnswerParts parts={r.parts} citations={r.citations} />
            <p className="mt-3 text-xs text-muted">Grounded in version {r.revisionNumber}</p>
          </div>
        ) : (
          <div className={cn("rounded-md border p-3", r.status === "preparing" ? "border-info/30 bg-info-soft" : "border-warning/40 bg-warning-soft")}>
            <p className={cn("font-medium", r.status === "preparing" ? "text-info" : "text-warning")}>{STATUS_COPY[r.status].title}</p>
            <p className="mt-1 text-sm text-fg">{STATUS_COPY[r.status].body}</p>
            {r.missing ? (
              <p className="mt-2 text-sm text-fg">
                <span className="font-medium text-ink">What's missing: </span>
                {r.missing}
              </p>
            ) : null}
            {r.parts.length ? (
              <div className="mt-3">
                <AnswerParts parts={r.parts} citations={r.citations} />
              </div>
            ) : null}
            {r.status !== "preparing" ? <SendToAuthor target={target} exchange={ex} threadId={r.threadId ?? threadId} /> : null}
          </div>
        )
      ) : null}
    </li>
  );
}

function threadToExchanges(t: ThreadDto): Exchange[] {
  const out: Exchange[] = [];
  for (const m of t.messages) {
    if (m.role === "reader") out.push({ id: m.id, question: m.text ?? "", pending: false });
    else {
      const last = out[out.length - 1];
      if (!last || !m.status) continue;
      last.result = {
        threadId: t.threadId,
        status: m.status,
        parts: m.parts ?? [],
        citations: m.citations,
        revisionNumber: t.revisionNumber,
        ...(m.missing ? { missing: m.missing } : {}),
      };
    }
  }
  return out;
}

/** Private, revision-bound Q&A. Nothing here reaches the author unless the reader explicitly sends it. */
export function AskPanel({ target, focus, perspective, threads, minCohort, clearFocusHref, conversation, setConversation, inputRef }: AskPanelProps) {
  const [question, setQuestion] = useState("");
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const ask = (text: string, threadId: string | null, note?: string) => {
    const id = nextId();
    const ex: Exchange = { id, question: text, pending: true, ...(focus ? { focusBlockId: focus.id, focusLabel: focus.label } : {}), ...(note ? { note } : {}) };
    setConversation((c) => ({ ...c, exchanges: [...c.exchanges, ex] }));
    startTransition(async () => {
      const res = await askAction({
        ...target,
        question: text,
        ...(focus ? { focusBlockId: focus.id } : {}),
        ...(perspective ? { perspectiveId: perspective.id } : {}),
        ...(threadId ? { threadId } : {}),
      });
      if (!res.ok && res.threadMismatch) {
        // Never continue a conversation grounded in another version: start a new one for this version.
        setConversation((c) => ({ threadId: null, exchanges: c.exchanges.filter((e) => e.id !== id) }));
        ask(text, null, `Started a new conversation for version ${target.revisionNumber}; the earlier one was about a different version.`);
        return;
      }
      setConversation((c) => ({
        threadId: res.ok ? (res.result.threadId ?? c.threadId) : c.threadId,
        exchanges: c.exchanges.map((e) => (e.id === id ? { ...e, pending: false, ...(res.ok ? { result: res.result } : { error: res.message }) } : e)),
      }));
      if (res.ok && res.result.threadId) router.refresh();
    });
  };

  const submit = () => {
    const text = question.trim();
    if (!text || pending) return;
    setQuestion("");
    ask(text, conversation.threadId);
  };

  const others = threads.filter((t) => t.threadId !== conversation.threadId);

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-medium tracking-[0.12em] text-muted uppercase">About: {focus ? focus.label : "the whole briefing"}</p>
        {focus ? (
          <Link href={clearFocusHref} scroll={false} className={cn("shrink-0 text-xs text-accent underline underline-offset-2", focusRing)}>
            Ask about the whole briefing
          </Link>
        ) : null}
      </div>
      {perspective ? <p className="mt-1 text-xs text-muted">Reading for {perspective.label}</p> : null}

      {conversation.exchanges.length ? (
        <ol aria-label="This conversation" aria-live="polite" className="mt-4 flex flex-col gap-6">
          {conversation.exchanges.map((ex) => (
            <ExchangeView key={ex.id} ex={ex} target={target} threadId={conversation.threadId} />
          ))}
        </ol>
      ) : (
        <p className="mt-4 text-sm text-muted">
          Ask a question about version {target.revisionNumber}. Answers come only from this version and its approved evidence, and say when
          something isn't covered.
        </p>
      )}

      <form
        className="mt-6"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label htmlFor="ask-question" className="sr-only">
          {conversation.exchanges.length ? "Ask a follow-up" : "Ask a question about this briefing"}
        </label>
        <div className="flex items-end gap-2 rounded-lg border border-line-strong bg-surface p-2 focus-within:outline-2 focus-within:outline-focus">
          <textarea
            ref={inputRef}
            id="ask-question"
            name="question"
            rows={2}
            maxLength={2000}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={conversation.exchanges.length ? "Ask a follow-up…" : "Ask about this briefing…"}
            aria-describedby="ask-privacy"
            className="min-h-12 flex-1 resize-none bg-transparent px-2 py-1 text-base text-fg outline-none placeholder:text-muted"
          />
          <Button type="submit" size="sm" aria-disabled={pending || !question.trim() || undefined} aria-label="Ask">
            {pending ? "Asking…" : "Ask"}
          </Button>
        </div>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <p id="ask-privacy" className="text-sm text-muted">
            Your questions are private.
          </p>
          {conversation.exchanges.length ? (
            <button
              type="button"
              className={cn("text-sm text-accent underline underline-offset-2", focusRing)}
              onClick={() => setConversation({ threadId: null, exchanges: [] })}
            >
              New conversation
            </button>
          ) : null}
        </div>
        <details className="mt-2 text-sm text-muted">
          <summary className={cn("cursor-pointer rounded-sm underline underline-offset-2", focusRing)}>How privacy works</summary>
          <div className="mt-2 flex flex-col gap-2">
            <p>Only you can see your questions and the answers. The author is never shown your question text or your name.</p>
            <p>
              The author sees how many questions were asked and, when at least {minCohort} different readers ask about similar things, an
              automated topic summary.
            </p>
            <p>A question reaches the author only if you choose “Send this question to the author”, and then it is sent with your name.</p>
          </div>
        </details>
      </form>

      {others.length ? (
        <section aria-labelledby="ask-history" className="mt-8 border-t border-line pt-4">
          <h3 id="ask-history" className="text-sm font-medium text-ink">
            Your previous questions on version {target.revisionNumber}
          </h3>
          <ul className="mt-2 flex flex-col gap-2">
            {others.map((t) => {
              const exchanges = threadToExchanges(t);
              const first = exchanges[0]?.question ?? "Conversation";
              return (
                <li key={t.threadId}>
                  <details className="rounded-md border border-line bg-paper p-3">
                    <summary className={cn("cursor-pointer rounded-sm text-sm text-ink", focusRing)}>
                      {first}
                      <span className="ml-2 text-xs text-muted">{formatDateTime(t.updatedAt)}</span>
                    </summary>
                    <ol className="mt-3 flex flex-col gap-4">
                      {exchanges.map((ex) => (
                        <ExchangeView key={ex.id} ex={ex} target={target} threadId={t.threadId} />
                      ))}
                    </ol>
                    <Button
                      variant="secondary"
                      size="sm"
                      className="mt-3"
                      onClick={() => {
                        setConversation({ threadId: t.threadId, exchanges });
                        inputRef.current?.focus();
                      }}
                    >
                      Continue this conversation
                    </Button>
                  </details>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
