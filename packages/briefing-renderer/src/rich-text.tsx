import { Fragment, type ReactNode } from "react";

/*
 * Safe renderer for the briefing RichText syntax:
 *   paragraphs separated by blank lines, **bold**, _italic_, [label](https://url)
 * Everything else is rendered as text, which React escapes. Only http(s) links
 * are emitted. There is no HTML passthrough and no dangerouslySetInnerHTML.
 */

export type InlineNode =
  | { type: "text"; text: string }
  | { type: "strong"; children: InlineNode[] }
  | { type: "em"; children: InlineNode[] }
  | { type: "link"; href: string; children: InlineNode[] };

const MAX_DEPTH = 4;

/** Returns a normalised href for http(s) URLs, otherwise null. */
export function safeHref(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

const isWord = (ch: string | undefined) => !!ch && /[\p{L}\p{N}]/u.test(ch);

export function parseInline(input: string, depth = 0, allowLinks = true): InlineNode[] {
  const nodes: InlineNode[] = [];
  let text = "";
  const flush = () => {
    if (text) nodes.push({ type: "text", text });
    text = "";
  };

  let i = 0;
  while (i < input.length) {
    if (depth < MAX_DEPTH) {
      // **bold**
      if (input.startsWith("**", i)) {
        const end = input.indexOf("**", i + 2);
        if (end > i + 2) {
          flush();
          nodes.push({ type: "strong", children: parseInline(input.slice(i + 2, end), depth + 1, allowLinks) });
          i = end + 2;
          continue;
        }
      }
      // _italic_ (not inside words, so snake_case stays literal)
      if (input[i] === "_" && !isWord(input[i - 1])) {
        let end = input.indexOf("_", i + 1);
        while (end !== -1 && isWord(input[end + 1])) end = input.indexOf("_", end + 1);
        if (end > i + 1) {
          flush();
          nodes.push({ type: "em", children: parseInline(input.slice(i + 1, end), depth + 1, allowLinks) });
          i = end + 1;
          continue;
        }
      }
      // [label](url)
      if (allowLinks && input[i] === "[") {
        // URL may contain one level of balanced parentheses, e.g. wiki links.
        const m = /^\[([^\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/.exec(input.slice(i));
        if (m) {
          const href = safeHref(m[2]!);
          if (href) {
            flush();
            nodes.push({ type: "link", href, children: parseInline(m[1]!, depth + 1, false) });
          } else {
            // Unsafe or invalid URL: keep the label as text, drop the target.
            text += m[1]!;
          }
          i += m[0].length;
          continue;
        }
      }
    }
    text += input[i];
    i++;
  }
  flush();
  return nodes;
}

export function splitParagraphs(text: string): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n[ \t]*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

function renderNodes(nodes: InlineNode[]): ReactNode[] {
  return nodes.map((n, i) => {
    switch (n.type) {
      case "text": {
        const lines = n.text.split("\n");
        return (
          <Fragment key={i}>
            {lines.map((line, j) => (
              <Fragment key={j}>
                {j > 0 ? <br /> : null}
                {line}
              </Fragment>
            ))}
          </Fragment>
        );
      }
      case "strong":
        return (
          <strong key={i} className="font-semibold text-ink">
            {renderNodes(n.children)}
          </strong>
        );
      case "em":
        return <em key={i}>{renderNodes(n.children)}</em>;
      case "link":
        return (
          <a
            key={i}
            href={n.href}
            rel="noopener noreferrer"
            target="_blank"
            className="text-accent underline decoration-1 underline-offset-2 hover:decoration-2"
          >
            {renderNodes(n.children)}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        );
    }
  });
}

export interface RichTextProps {
  text: string;
  className?: string;
  paragraphClassName?: string;
  /** Appended inline to the last paragraph, e.g. evidence markers. */
  trailing?: ReactNode;
}

export function RichText({ text, className, paragraphClassName = "mb-4 last:mb-0", trailing }: RichTextProps) {
  const paragraphs = splitParagraphs(text);
  return (
    <div className={className}>
      {paragraphs.map((p, i) => (
        <p key={i} className={paragraphClassName}>
          {renderNodes(parseInline(p))}
          {trailing && i === paragraphs.length - 1 ? <> {trailing}</> : null}
        </p>
      ))}
    </div>
  );
}

/** Plain text with inline marks removed, for word counts and accessible labels. */
export function richTextToPlain(text: string): string {
  const walk = (nodes: InlineNode[]): string =>
    nodes.map((n) => (n.type === "text" ? n.text : walk(n.children))).join("");
  return splitParagraphs(text)
    .map((p) => walk(parseInline(p)))
    .join("\n\n");
}
