/**
 * The MCP Apps inline preview (T14, W3.1): one self-contained HTML document
 * served as the `ui://` resource for `preview_brief` and `publish_brief`.
 *
 * - It is a static template. The data it shows is the tool result the host
 *   forwards (`ui/notifications/tool-result`), i.e. the server-bound preview's
 *   `structuredContent`. Every value is written with `textContent`; nothing is
 *   parsed as HTML.
 * - The Publish control calls the existing `publish_brief` tool through the
 *   host bridge (`tools/call`) with the server-issued `briefing_id` and
 *   `preview_id` only. It never sends content, home or audience. The preview
 *   binding (T15) stays the security boundary: a stale, expired or used
 *   preview is refused server-side exactly as for any other caller.
 * - No network access and no external loads: the CSP below allows only this
 *   document's own inline script and style (by hash), and `data:` images.
 *   The bridge is hand-written JSON-RPC over `postMessage` (MCP Apps
 *   2026-01-26), so no SDK bundle is inlined.
 *
 * Keep the colour values in step with `packages/ui/src/tokens.css`
 * (`test/mcp-apps.test.ts` checks them).
 */
import { createHash } from "node:crypto";

/** MCP Apps protocol version this view speaks in `ui/initialize`. */
export const MCP_APPS_PROTOCOL_VERSION = "2026-01-26";

const STYLE = `
:root {
  color-scheme: light;
  --cb-background: #f7f4ee;
  --cb-surface: #fdfbf7;
  --cb-muted: #efebe3;
  --cb-ink: #17161c;
  --cb-foreground: #2a2930;
  --cb-muted-foreground: #5d5952;
  --cb-accent: #4a43b5;
  --cb-accent-hover: #3c3699;
  --cb-accent-foreground: #ffffff;
  --cb-accent-soft: #e9e7f8;
  --cb-accent-ink: #322c85;
  --cb-border: #e2ddd3;
  --cb-border-strong: #8b857b;
  --cb-focus: #4a43b5;
  --cb-success: #1d6a40;
  --cb-success-soft: #e3f1e7;
  --cb-warning: #7f5100;
  --cb-warning-soft: #f8ecd2;
  --cb-danger: #b0261b;
  --cb-danger-soft: #f8e3df;
  --font-serif: "Source Serif 4", "Iowan Old Style", "Palatino Linotype", Georgia, serif;
  --font-sans: "Inter", system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --cb-background: #16151a;
    --cb-surface: #1d1c22;
    --cb-muted: #26252c;
    --cb-ink: #f4f0e8;
    --cb-foreground: #e4dfd6;
    --cb-muted-foreground: #aaa49a;
    --cb-accent: #a9a4ff;
    --cb-accent-hover: #c0bcff;
    --cb-accent-foreground: #16151a;
    --cb-accent-soft: #2a2852;
    --cb-accent-ink: #d6d3ff;
    --cb-border: #302f37;
    --cb-border-strong: #7a7580;
    --cb-focus: #a9a4ff;
    --cb-success: #7fd1a0;
    --cb-success-soft: #173324;
    --cb-warning: #f0c069;
    --cb-warning-soft: #3a2c10;
    --cb-danger: #ff9a8f;
    --cb-danger-soft: #3d1a17;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --cb-background: #16151a;
  --cb-surface: #1d1c22;
  --cb-muted: #26252c;
  --cb-ink: #f4f0e8;
  --cb-foreground: #e4dfd6;
  --cb-muted-foreground: #aaa49a;
  --cb-accent: #a9a4ff;
  --cb-accent-hover: #c0bcff;
  --cb-accent-foreground: #16151a;
  --cb-accent-soft: #2a2852;
  --cb-accent-ink: #d6d3ff;
  --cb-border: #302f37;
  --cb-border-strong: #7a7580;
  --cb-focus: #a9a4ff;
  --cb-success: #7fd1a0;
  --cb-success-soft: #173324;
  --cb-warning: #f0c069;
  --cb-warning-soft: #3a2c10;
  --cb-danger: #ff9a8f;
  --cb-danger-soft: #3d1a17;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  background: var(--cb-background);
  color: var(--cb-foreground);
  font-family: var(--font-sans);
  font-size: 15px;
  line-height: 1.5;
}
main { padding: 16px; max-width: 44rem; }
h1, h2, h3, p, ul, ol, dl, dd { margin: 0; }
h1 { font-family: var(--font-serif); font-size: 1.5rem; line-height: 1.25; color: var(--cb-ink); margin-top: 4px; }
h2 { font-size: 0.75rem; font-weight: 600; letter-spacing: 0.12em; text-transform: uppercase; color: var(--cb-muted-foreground); }
.meta { color: var(--cb-muted-foreground); font-size: 0.875rem; }
.pill {
  display: inline-block; border-radius: 999px; padding: 2px 10px; font-size: 0.75rem; font-weight: 600;
  background: var(--cb-warning-soft); color: var(--cb-warning);
}
.pill.ok { background: var(--cb-success-soft); color: var(--cb-success); }
.block { margin-top: 16px; }
.headline { font-family: var(--font-serif); font-size: 1.125rem; color: var(--cb-ink); margin-top: 4px; }
.summary { margin-top: 6px; white-space: pre-line; }
.ask { margin-top: 16px; border: 1px solid var(--cb-accent); border-radius: 8px; background: var(--cb-accent-soft); color: var(--cb-accent-ink); padding: 12px 14px; }
.ask h2 { color: var(--cb-accent-ink); }
.ask .statement { font-family: var(--font-serif); font-size: 1.125rem; margin-top: 4px; }
.facts { margin-top: 16px; display: grid; grid-template-columns: max-content 1fr; gap: 6px 14px; border-top: 1px solid var(--cb-border); padding-top: 12px; }
.facts dt { font-weight: 600; color: var(--cb-ink); }
ul, ol { padding-left: 1.25rem; margin-top: 6px; }
li + li { margin-top: 2px; }
.note { margin-top: 12px; border-radius: 8px; padding: 10px 12px; background: var(--cb-warning-soft); color: var(--cb-warning); }
.note.error { background: var(--cb-danger-soft); color: var(--cb-danger); }
.note.ok { background: var(--cb-success-soft); color: var(--cb-success); }
.note p + p, .note p + ul { margin-top: 6px; }
.actions { margin-top: 16px; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; border-top: 1px solid var(--cb-border); padding-top: 12px; }
button {
  font: inherit; font-weight: 600; min-height: 44px; padding: 8px 16px; border-radius: 8px; cursor: pointer;
  border: 1px solid var(--cb-border-strong); background: var(--cb-surface); color: var(--cb-ink);
}
button.primary { background: var(--cb-accent); border-color: var(--cb-accent); color: var(--cb-accent-foreground); }
button.primary:hover:not(:disabled) { background: var(--cb-accent-hover); }
button:disabled { cursor: not-allowed; opacity: 0.55; }
button:focus-visible, [tabindex="-1"]:focus-visible { outline: 3px solid var(--cb-focus); outline-offset: 2px; }
.confirm { margin-top: 12px; border: 2px solid var(--cb-accent); border-radius: 8px; padding: 12px 14px; background: var(--cb-surface); }
.confirm h2 { font-size: 1rem; letter-spacing: 0; text-transform: none; color: var(--cb-ink); }
.confirm .actions { border-top: 0; padding-top: 0; margin-top: 10px; }
.status { margin-top: 10px; min-height: 1.5em; color: var(--cb-muted-foreground); font-size: 0.875rem; }
[hidden] { display: none !important; }
`;

const SCRIPT = `
(function () {
  "use strict";
  var PROTOCOL_VERSION = "${MCP_APPS_PROTOCOL_VERSION}";
  var STALE_REASONS = {
    draft_version: "The draft was saved again after the preview.",
    content: "The briefing content changed.",
    evidence: "Evidence approval changed.",
    publication: "Another version was published or withdrawn since the preview.",
    home: "The briefing's home changed.",
    audience: "The audience or named readers changed.",
    expired: "The preview expired.",
    consumed: "This preview was already used.",
    unknown: "Something changed since the preview."
  };
  var host = window.parent;
  var nextId = 1;
  var pending = {};
  var hostCaps = {};
  var locale;
  var toolArgs = {};
  var current = null;
  var publishKey = null;
  var busy = false;
  var root = document.getElementById("app");

  function send(message) { host.postMessage(message, "*"); }
  function request(method, params) {
    var id = nextId++;
    return new Promise(function (resolve, reject) {
      pending[id] = { resolve: resolve, reject: reject };
      send({ jsonrpc: "2.0", id: id, method: method, params: params });
    });
  }
  function notify(method, params) { send({ jsonrpc: "2.0", method: method, params: params || {} }); }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    var key;
    for (key in attrs || {}) {
      if (key === "text") node.textContent = attrs[key];
      else if (key === "hidden" || key === "disabled") node[key] = !!attrs[key];
      else node.setAttribute(key, attrs[key]);
    }
    (children || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : (many || one + "s")); }
  function list(items, map) { return el("ul", {}, items.map(function (x) { return el("li", { text: map(x) }); })); }
  function clear() { while (root.firstChild) root.removeChild(root.firstChild); }
  function freshKey() {
    var bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return "mcp-app-" + Array.prototype.map.call(bytes, function (b) { return (b + 256).toString(16).slice(1); }).join("");
  }
  function formatTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    try { return d.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" }); } catch (e) { return d.toISOString(); }
  }
  function textOf(result) {
    return ((result && result.content) || []).map(function (c) { return c && c.type === "text" ? c.text : ""; }).join("\\n");
  }
  function setStatus(text) { var s = document.getElementById("status"); if (s) s.textContent = text; }
  function canCallTools() { return !!hostCaps.serverTools; }
  function updateModelContext(text) {
    if (!hostCaps.updateModelContext) return;
    request("ui/update-model-context", { content: [{ type: "text", text: text }] }).catch(function () {});
  }
  function openLinkButton(url, label) {
    if (!hostCaps.openLinks || typeof url !== "string" || !/^https?:/i.test(url)) return null;
    var b = el("button", { type: "button", text: label });
    b.addEventListener("click", function () { request("ui/open-link", { url: url }).catch(function () { setStatus("The host did not open the link."); }); });
    return b;
  }

  function evidenceFacts(p) {
    var ev = p.evidence || { approved: [], candidates: [], excluded: [] };
    var parts = [];
    parts.push(ev.approved.length ? plural(ev.approved.length, "approved excerpt") + " will publish" : "No supporting evidence attached");
    if (ev.candidates.length) parts.push(plural(ev.candidates.length, "candidate") + " awaiting approval will not publish");
    if (ev.excluded.length) parts.push(ev.excluded.length + " excluded, stays private");
    return parts.join("; ") + ".";
  }

  function renderPreview(p) {
    current = p;
    publishKey = freshKey();
    clear();
    var sections = p.sections || [];
    var errors = p.validation_issues || [];
    var warnings = p.warnings || [];
    var dropped = p.claims_without_evidence || [];
    var publishLabel = p.current_revision_number ? "Publish version " + (p.current_revision_number + 1) : "Publish";
    var main = el("main", { "aria-labelledby": "brief-title" }, [
      el("p", {}, [el("span", { "class": "pill", text: "Preview \\u00b7 Not published" })]),
      el("h1", { id: "brief-title", text: p.title || "Untitled brief" }),
      p.kind_label ? el("p", { "class": "meta", text: p.kind_label }) : null,
      p.position ? el("section", { "class": "block", "aria-labelledby": "position-label" }, [
        el("h2", { id: "position-label", text: "Position" }),
        el("p", { "class": "headline", text: p.position.headline }),
        p.position.summary ? el("p", { "class": "summary", text: p.position.summary }) : null
      ]) : null,
      p.request ? el("section", { "class": "ask", "aria-labelledby": "request-label" }, [
        el("h2", { id: "request-label", text: p.request.label }),
        el("p", { "class": "statement", text: p.request.statement }),
        p.request.detail ? el("p", { "class": "summary", text: p.request.detail }) : null,
        p.request.due_date_label ? el("p", { "class": "meta", text: "Needed by " + p.request.due_date_label }) : null
      ]) : null,
      el("dl", { "class": "facts", "aria-label": "Where and to whom this publishes" }, [
        el("dt", { text: "Home" }), el("dd", { text: (p.home && p.home.label) || "" }),
        el("dt", { text: "Audience" }), el("dd", { text: p.audience_statement || "" }),
        el("dt", { text: "Evidence" }), el("dd", { text: evidenceFacts(p) }),
        el("dt", { text: "Sections" }), el("dd", { text: String(sections.length) })
      ]),
      sections.length ? el("section", { "class": "block", "aria-labelledby": "sections-label" }, [
        el("h2", { id: "sections-label", text: "Sections" }),
        el("ol", {}, sections.map(function (s) { return el("li", { text: s.title + " (" + plural(s.blockCount, "block") + ")" }); }))
      ]) : null,
      dropped.length ? el("div", { "class": "note", role: "note" }, [el("p", { text: plural(dropped.length, "claim") + " will publish without evidence." })]) : null,
      errors.length ? el("div", { "class": "note error", role: "note" }, [
        el("p", { text: "Errors blocking publication (" + errors.length + "):" }),
        list(errors, function (i) { return i.message; })
      ]) : null,
      warnings.length ? el("div", { "class": "note", role: "note" }, [
        el("p", { text: "Warnings, publishable (" + warnings.length + "):" }),
        list(warnings, function (i) { return i.message; })
      ]) : null,
      (p.change_summary || []).length ? el("section", { "class": "block", "aria-labelledby": "changes-label" }, [
        el("h2", { id: "changes-label", text: p.current_revision_number ? "Changes since version " + p.current_revision_number : "Change summary" }),
        list(p.change_summary, function (l) { return l; })
      ]) : null,
      el("p", { "class": "meta block", text: "Preview of draft version " + p.draft_version + ". Expires " + formatTime(p.expires_at) + "." }),
      el("div", { "class": "actions" }, [
        el("button", { id: "publish", type: "button", "class": "primary", "aria-expanded": "false", "aria-controls": "confirm", disabled: !p.can_publish || !canCallTools(), text: publishLabel }),
        openLinkButton(p.preview_url, "Review in Cerebro")
      ]),
      !p.can_publish ? el("p", { "class": "meta", text: "Fix the errors above before publishing." }) :
        !canCallTools() ? el("p", { "class": "meta", text: "This host cannot publish from here. Review and publish in Cerebro." }) : null,
      el("div", { id: "confirm", "class": "confirm", role: "group", "aria-labelledby": "confirm-title", hidden: true }, [
        el("h2", { id: "confirm-title", tabindex: "-1", text: "Publish this preview?" }),
        el("p", { "class": "summary", text: "This publishes exactly the preview above to " + ((p.home && p.home.label) || "its home") + ", readable by " + (p.audience_statement || "its audience") + ". It creates a permanent revision colleagues can discover. Only approved evidence is included." }),
        el("div", { "class": "actions" }, [
          el("button", { id: "confirm-publish", type: "button", "class": "primary", text: "Confirm and publish" }),
          el("button", { id: "cancel-publish", type: "button", text: "Cancel" })
        ])
      ]),
      el("div", { id: "outcome" }),
      el("p", { id: "status", "class": "status", role: "status", "aria-live": "polite" })
    ]);
    root.appendChild(main);
    wirePreview();
  }

  function wirePreview() {
    var publish = document.getElementById("publish");
    var confirm = document.getElementById("confirm");
    var yes = document.getElementById("confirm-publish");
    var no = document.getElementById("cancel-publish");
    function close() {
      confirm.hidden = true;
      publish.setAttribute("aria-expanded", "false");
      publish.focus();
    }
    publish.addEventListener("click", function () {
      if (busy) return;
      confirm.hidden = false;
      publish.setAttribute("aria-expanded", "true");
      document.getElementById("confirm-title").focus();
    });
    no.addEventListener("click", close);
    confirm.addEventListener("keydown", function (e) { if (e.key === "Escape" && !busy) { e.preventDefault(); close(); } });
    yes.addEventListener("click", doPublish);
  }

  function setBusy(on) {
    busy = on;
    ["publish", "confirm-publish", "cancel-publish", "repreview"].forEach(function (id) {
      var b = document.getElementById(id);
      if (b) b.disabled = on || (id === "publish" && !(current && current.can_publish));
    });
  }

  function doPublish() {
    if (busy || !current) return;
    var reviewed = current;
    setBusy(true);
    setStatus("Publishing\\u2026");
    request("tools/call", {
      name: "publish_brief",
      arguments: { briefing_id: reviewed.briefing_id, preview_id: reviewed.preview_id, idempotency_key: publishKey }
    }).then(function (result) {
      setBusy(false);
      var sc = (result && result.structuredContent) || {};
      if (result && !result.isError && sc.status === "published") {
        renderPublished(sc, reviewed.title);
        updateModelContext("The user published \\"" + reviewed.title + "\\" from the inline Cerebro preview: revision " + sc.revision_number + " (" + sc.canonical_url + "). Do not publish it again.");
        return;
      }
      showPublishError(sc.error || { code: "unavailable", message: textOf(result) || "Nothing was published." });
    }, function () {
      setBusy(false);
      showPublishError({ code: "host", message: "The host did not complete the request, so the result is unknown. Trying again is safe: it cannot publish twice." });
    });
  }

  function showPublishError(error) {
    var outcome = document.getElementById("outcome");
    var confirm = document.getElementById("confirm");
    var publish = document.getElementById("publish");
    var reasons = (error.details && error.details.reasons) || [];
    var stale = error.code === "stale_preview";
    confirm.hidden = true;
    publish.setAttribute("aria-expanded", "false");
    while (outcome.firstChild) outcome.removeChild(outcome.firstChild);
    var children = [
      el("p", { text: (stale ? "Not published: this preview is out of date. " : "Not published. ") + (error.message || "") }),
      reasons.length ? list(reasons, function (r) { return STALE_REASONS[r] || STALE_REASONS.unknown; }) : null
    ];
    if (stale) {
      publish.disabled = true;
      children.push(el("p", { text: "Preview again to review the current draft before publishing." }));
    }
    var box = el("div", { "class": "note error", role: "alert" }, children);
    outcome.appendChild(box);
    if (stale && canCallTools()) {
      var again = el("button", { id: "repreview", type: "button", text: "Preview again" });
      again.addEventListener("click", rePreview);
      outcome.appendChild(el("div", { "class": "actions" }, [again]));
      again.focus();
    }
    setStatus("");
  }

  function rePreview() {
    var briefingId = (current && current.briefing_id) || toolArgs.briefing_id;
    if (busy || !briefingId) return;
    setBusy(true);
    setStatus("Preparing a new preview\\u2026");
    request("tools/call", { name: "preview_brief", arguments: { briefing_id: briefingId } }).then(function (result) {
      setBusy(false);
      render(result);
      var sc = (result && result.structuredContent) || {};
      if (sc.status === "preview") {
        updateModelContext("The user refreshed the inline Cerebro preview of \\"" + sc.title + "\\". The current preview_id is " + sc.preview_id + ". It is not published.");
        var h = document.getElementById("brief-title");
        if (h) { h.setAttribute("tabindex", "-1"); h.focus(); }
      }
    }, function () {
      setBusy(false);
      setStatus("The host did not complete the request. Try again, or review in Cerebro.");
    });
  }

  function renderPublished(sc, title) {
    current = null;
    clear();
    var main = el("main", { "aria-labelledby": "published-title" }, [
      el("p", {}, [el("span", { "class": "pill ok", text: "Published" })]),
      el("h1", { id: "published-title", tabindex: "-1", text: title || "Brief published" }),
      el("div", { "class": "note ok", role: "status" }, [
        el("p", { text: (sc.replayed ? "Already published; no new revision was created. " : "Published. ") + "Revision " + sc.revision_number + " is now available to its audience." })
      ]),
      el("div", { "class": "actions" }, [openLinkButton(sc.canonical_url, "Open in Cerebro")])
    ]);
    root.appendChild(main);
    document.getElementById("published-title").focus();
  }

  function renderError(error, input) {
    current = null;
    clear();
    root.appendChild(el("main", { "aria-labelledby": "error-title" }, [
      el("h1", { id: "error-title", text: "Cerebro could not show this preview" }),
      el("div", { "class": "note error", role: "alert" }, [el("p", { text: error.message || "Nothing was published." })]),
      el("p", { id: "status", "class": "status", role: "status", "aria-live": "polite" })
    ]));
  }

  function render(result) {
    var sc = (result && result.structuredContent) || {};
    if (result && result.isError) return renderError(sc.error || { message: textOf(result) });
    if (sc.status === "preview") return renderPreview(sc);
    if (sc.status === "published") return renderPublished(sc, sc.title);
    return renderError({ message: textOf(result) || "Nothing to show." });
  }

  function applyContext(ctx) {
    if (!ctx) return;
    if (ctx.theme === "light" || ctx.theme === "dark") document.documentElement.setAttribute("data-theme", ctx.theme);
    if (typeof ctx.locale === "string") locale = ctx.locale;
  }

  window.addEventListener("message", function (event) {
    if (event.source !== host) return;
    var msg = event.data;
    if (!msg || msg.jsonrpc !== "2.0") return;
    if (msg.method === undefined) {
      var p = pending[msg.id];
      if (!p) return;
      delete pending[msg.id];
      if (msg.error) p.reject(msg.error); else p.resolve(msg.result);
      return;
    }
    if (msg.id !== undefined) {
      if (msg.method === "ui/resource-teardown" || msg.method === "ping") send({ jsonrpc: "2.0", id: msg.id, result: {} });
      else send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
      return;
    }
    if (msg.method === "ui/notifications/tool-input") toolArgs = (msg.params && msg.params.arguments) || {};
    else if (msg.method === "ui/notifications/tool-result") render(msg.params);
    else if (msg.method === "ui/notifications/tool-cancelled") renderError({ message: "The request was cancelled. Nothing was published." });
    else if (msg.method === "ui/notifications/host-context-changed") applyContext(msg.params);
  });

  if (typeof ResizeObserver === "function") {
    new ResizeObserver(function () {
      var d = document.documentElement;
      notify("ui/notifications/size-changed", { width: Math.ceil(d.scrollWidth), height: Math.ceil(d.scrollHeight) });
    }).observe(document.documentElement);
  }

  request("ui/initialize", {
    appInfo: { name: "cerebro-brief-preview", version: "1.0.0" },
    appCapabilities: { availableDisplayModes: ["inline"] },
    protocolVersion: PROTOCOL_VERSION
  }).then(function (result) {
    hostCaps = (result && result.hostCapabilities) || {};
    applyContext(result && result.hostContext);
    notify("ui/notifications/initialized", {});
  }, function () {
    setStatus("This host did not start the Cerebro preview. Use the text summary and review link instead.");
  });
})();
`;

const cspHash = (source: string) => `'sha256-${createHash("sha256").update(source, "utf8").digest("base64")}'`;

/**
 * The document's own Content Security Policy (a `<meta>` tag, applied on top
 * of whatever the host enforces). Only this document's inline script and
 * style run; no network, frames, forms, plugins or base-URL changes.
 */
export const PREVIEW_UI_CSP = [
  "default-src 'none'",
  `script-src ${cspHash(SCRIPT)}`,
  `style-src ${cspHash(STYLE)}`,
  "img-src data:",
  "font-src 'none'",
  "connect-src 'none'",
  "media-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/** The complete, self-contained HTML5 document served for the preview UI resource. */
export const PREVIEW_UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${PREVIEW_UI_CSP}">
<meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Cerebro brief preview</title>
<style>${STYLE}</style>
</head>
<body>
<div id="app"><main><p class="status" role="status" aria-live="polite" id="status">Loading the Cerebro preview…</p></main></div>
<script>${SCRIPT}</script>
</body>
</html>
`;
