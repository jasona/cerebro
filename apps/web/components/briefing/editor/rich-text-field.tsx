"use client";

import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { editorDocKey, editorDocToRichText, richTextToEditorDoc, safeHref } from "@cerebro/briefing-renderer";
import { Button, cn, Input } from "@cerebro/ui";

/*
 * Rich-text field for the briefing's prose (schema `RichText`) fields.
 *
 * The stored value stays the RichText string; the editor schema is trimmed to
 * what that syntax can hold: paragraphs, hard breaks, bold, italic and
 * http(s) links. Conversion lives in `@cerebro/briefing-renderer`
 * (`richTextToEditorDoc` / `editorDocToRichText`) and uses the renderer's own
 * parser, so the field shows what readers will see.
 *
 * The field reports changes as strings, exactly like a textarea, so the
 * editor's dirty state, save and optimistic-concurrency handling are unchanged.
 */

export interface RichTextFieldProps {
  /** id of the editable element; the label, toolbar and hint derive from it. */
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  hint?: ReactNode;
  /** Minimum height, in lines, like a textarea's `rows`. */
  rows?: number;
  fieldClassName?: string;
}

/** Shortcut prefix for labels; "Ctrl+" until mounted so server and client markup match. */
function useModKey(): string {
  const [mod, setMod] = useState("Ctrl+");
  useEffect(() => {
    if (/Mac|iPhone|iPad/.test(navigator.userAgent)) setMod("⌘");
  }, []);
  return mod;
}

function extensions() {
  return [
    StarterKit.configure({
      // Only what the RichText syntax supports.
      blockquote: false,
      bulletList: false,
      code: false,
      codeBlock: false,
      dropcursor: false,
      gapcursor: false,
      heading: false,
      horizontalRule: false,
      listItem: false,
      listKeymap: false,
      orderedList: false,
      strike: false,
      trailingNode: false,
      underline: false,
      link: {
        autolink: false,
        openOnClick: false,
        linkOnPaste: true,
        defaultProtocol: "https",
        isAllowedUri: (url) => !!safeHref(url),
        HTMLAttributes: { rel: "noopener noreferrer", target: null, class: null },
      },
    }),
  ];
}

export function RichTextField({ id, label, value, onChange, required, hint, rows = 3, fieldClassName }: RichTextFieldProps) {
  const labelId = `${id}-label`;
  const hintId = `${id}-hint`;
  const keysId = `${id}-keys`;
  const wrapperRef = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // The last value set from outside, with its rendering key. Edits that return
  // to the same rendering report this exact string, so undo clears "Unsaved changes".
  const base = useRef({ text: value, key: editorDocKey(richTextToEditorDoc(value)) });
  const lastEmitted = useRef(value);
  const [linkOpen, setLinkOpen] = useState(false);
  const mod = useModKey();
  const openLinkRef = useRef<() => void>(() => {});

  const editor = useEditor({
    immediatelyRender: false,
    shouldRerenderOnTransaction: false,
    extensions: extensions(),
    content: richTextToEditorDoc(value),
    editorProps: {
      attributes: {
        id,
        role: "textbox",
        "aria-multiline": "true",
        "aria-labelledby": labelId,
        "aria-describedby": [hint ? hintId : null, keysId].filter(Boolean).join(" "),
        ...(required ? { "aria-required": "true" } : {}),
        class: cn(
          "w-full rounded-b-md px-3 py-2 text-base leading-relaxed text-fg",
          "focus:outline-2 focus:-outline-offset-2 focus:outline-focus",
          "[&_p+p]:mt-3 [&_strong]:font-semibold [&_strong]:text-ink",
          "[&_a]:text-accent [&_a]:underline [&_a]:decoration-1 [&_a]:underline-offset-2",
        ),
        style: `min-height: ${rows * 1.625 + 1}rem`,
      },
      handleKeyDown: (_view, event) => {
        if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "k") {
          event.preventDefault();
          openLinkRef.current();
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor: e }) => {
      const json = e.getJSON();
      const text = editorDocKey(json) === base.current.key ? base.current.text : editorDocToRichText(json);
      if (text === lastEmitted.current) return;
      lastEmitted.current = text;
      onChangeRef.current(text);
    },
    onBlur: ({ editor: e, event }) => {
      // Leaving the field: show the canonical form of what was typed (e.g. an
      // italic inside a word, which the syntax cannot hold, is shown plain).
      if (event.relatedTarget instanceof Node && wrapperRef.current?.contains(event.relatedTarget)) return;
      const json = e.getJSON();
      const canonical = richTextToEditorDoc(editorDocToRichText(json));
      if (editorDocKey(canonical) !== editorDocKey(json)) e.commands.setContent(canonical, { emitUpdate: false });
    },
  });

  // Adopt values set from outside (reload after a conflict, a newer server version).
  useEffect(() => {
    if (!editor || value === lastEmitted.current) return;
    lastEmitted.current = value;
    base.current = { text: value, key: editorDocKey(richTextToEditorDoc(value)) };
    editor.commands.setContent(richTextToEditorDoc(value), { emitUpdate: false });
  }, [editor, value]);

  const active = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e?.isActive("bold") ?? false,
      italic: e?.isActive("italic") ?? false,
      link: e?.isActive("link") ?? false,
    }),
  }) ?? { bold: false, italic: false, link: false };

  openLinkRef.current = () => setLinkOpen(true);

  return (
    <div ref={wrapperRef} className={cn("flex flex-col gap-1.5", fieldClassName)}>
      <div id={labelId} className="text-sm font-medium text-ink" onClick={() => editor?.commands.focus()}>
        {label}
        {required ? (
          <span className="text-muted">
            <span aria-hidden="true"> *</span>
            <span className="sr-only"> (required)</span>
          </span>
        ) : null}
      </div>
      <div className="rounded-md border border-line-strong bg-surface">
        <Toolbar editor={editor} label={label} controls={id} active={active} linkOpen={linkOpen} onLink={() => setLinkOpen((v) => !v)} mod={mod} />
        {linkOpen && editor ? (
          <LinkForm
            id={`${id}-link`}
            editor={editor}
            onClose={() => {
              setLinkOpen(false);
              editor.commands.focus();
            }}
          />
        ) : null}
        {editor ? (
          <EditorContent editor={editor} />
        ) : (
          // Before hydration: same footprint, no layout shift.
          <div aria-hidden="true" className="px-3 py-2 text-base leading-relaxed whitespace-pre-wrap text-fg" style={{ minHeight: `${rows * 1.625 + 1}rem` }}>
            {value}
          </div>
        )}
      </div>
      {hint ? (
        <p id={hintId} className="text-sm text-muted">
          {hint}
        </p>
      ) : null}
      <p id={keysId} className="sr-only">
        Rich text. {mod}B bold, {mod}I italic, {mod}K link. Enter starts a new paragraph; Shift+Enter adds a line break.
      </p>
    </div>
  );
}

type Active = { bold: boolean; italic: boolean; link: boolean };

/** WAI-ARIA toolbar: one tab stop, arrow keys move between buttons. */
function Toolbar({
  editor,
  label,
  controls,
  active,
  linkOpen,
  onLink,
  mod,
}: {
  editor: Editor | null;
  label: string;
  controls: string;
  active: Active;
  linkOpen: boolean;
  onLink: () => void;
  mod: string;
}) {
  const [current, setCurrent] = useState(0);
  const buttons: { name: string; glyph: ReactNode; pressed: boolean; keys: string; run: () => void; expanded?: boolean }[] = [
    { name: "Bold", glyph: <span className="font-bold">B</span>, pressed: active.bold, keys: `${mod}B`, run: () => editor?.chain().focus().toggleBold().run() },
    { name: "Italic", glyph: <span className="font-serif italic">I</span>, pressed: active.italic, keys: `${mod}I`, run: () => editor?.chain().focus().toggleItalic().run() },
    { name: "Link", glyph: <span className="underline underline-offset-2">Link</span>, pressed: active.link, keys: `${mod}K`, run: onLink, expanded: linkOpen },
  ];

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const last = buttons.length - 1;
    const next =
      e.key === "ArrowRight" ? (current === last ? 0 : current + 1) : e.key === "ArrowLeft" ? (current === 0 ? last : current - 1) : e.key === "Home" ? 0 : e.key === "End" ? last : null;
    if (next === null) return;
    e.preventDefault();
    setCurrent(next);
    document.getElementById(`${controls}-tool-${next}`)?.focus();
  };

  return (
    <div role="toolbar" aria-label={`${label} formatting`} aria-controls={controls} className="flex flex-wrap gap-1 border-b border-line px-1.5 py-1" onKeyDown={onKeyDown}>
      {buttons.map((b, i) => (
        <Button
          key={b.name}
          id={`${controls}-tool-${i}`}
          variant="ghost"
          size="sm"
          tabIndex={i === current ? 0 : -1}
          aria-label={b.name}
          aria-pressed={b.pressed}
          aria-expanded={b.expanded}
          aria-keyshortcuts={b.keys.replace("⌘", "Meta+").replace("Ctrl+", "Control+")}
          title={`${b.name} (${b.keys})`}
          disabled={!editor}
          className={cn("min-w-8 justify-center", b.pressed && "bg-accent-soft text-accent-ink")}
          // Keep the text selection: don't move focus out of the editor on mouse down.
          onMouseDown={(e) => e.preventDefault()}
          onFocus={() => setCurrent(i)}
          onClick={b.run}
        >
          {b.glyph}
        </Button>
      ))}
    </div>
  );
}

function LinkForm({ id, editor, onClose }: { id: string; editor: Editor; onClose: () => void }) {
  const existing = (editor.getAttributes("link").href as string | undefined) ?? "";
  const [url, setUrl] = useState(existing);
  const [error, setError] = useState("");
  useEffect(() => document.getElementById(`${id}-url`)?.focus(), [id]);

  const apply = () => {
    const href = safeHref(url.trim()) ?? safeHref(`https://${url.trim()}`);
    if (!url.trim() || !href || /\s/.test(url.trim())) {
      setError("Enter a web address, e.g. https://example.com.");
      return;
    }
    const chain = editor.chain().focus();
    if (editor.state.selection.empty && !editor.isActive("link")) {
      chain.insertContent({ type: "text", text: url.trim(), marks: [{ type: "link", attrs: { href } }] }).run();
    } else {
      chain.extendMarkRange("link").setLink({ href }).run();
    }
    onClose();
  };

  return (
    <div
      role="group"
      aria-label="Link"
      className="flex flex-wrap items-end gap-2 border-b border-line bg-subtle px-3 py-2"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        } else if (e.key === "Enter" && (e.target as HTMLElement).id === `${id}-url`) {
          e.preventDefault();
          apply();
        }
      }}
    >
      <Input
        id={`${id}-url`}
        label="Link address"
        type="url"
        inputMode="url"
        placeholder="https://"
        fieldClassName="min-w-48 flex-1"
        value={url}
        error={error || undefined}
        onChange={(e) => {
          setUrl(e.target.value);
          setError("");
        }}
      />
      <div className="flex gap-2 pb-0.5">
        <Button size="sm" onClick={apply}>
          Apply link
        </Button>
        {existing ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              editor.chain().focus().extendMarkRange("link").unsetLink().run();
              onClose();
            }}
          >
            Remove link
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
