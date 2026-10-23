"use server";

import { redirect } from "next/navigation";
import { addSource, createBriefing, isDomainError, type AudienceSpec, type HomeSpec } from "@cerebro/domain";
import { blankDocument } from "@/components/briefing/document-utils";
import { briefingPaths } from "@/lib/paths";
import type { ActionState } from "@/lib/action-state";
import { getRequestContext } from "@/lib/context";
import { errorMessage, field } from "@/lib/errors";

type UploadKind = "pdf" | "docx" | "pptx" | "markdown" | "text";

function uploadKind(file: File): UploadKind | null {
  const name = file.name.toLowerCase();
  if (name.endsWith(".pdf") || file.type === "application/pdf") return "pdf";
  if (name.endsWith(".docx")) return "docx";
  if (name.endsWith(".pptx")) return "pptx";
  if (name.endsWith(".md") || name.endsWith(".markdown") || file.type === "text/markdown") return "markdown";
  if (name.endsWith(".txt") || file.type.startsWith("text/")) return "text";
  return null;
}

function parseAudience(v: string): AudienceSpec | null {
  if (v === "company" || v === "restricted") return { visibility: v };
  const [kind, id] = v.split(":");
  if (kind === "department" && id) return { visibility: "department", departmentId: id };
  if (kind === "team" && id) return { visibility: "team", teamId: id };
  return null;
}

function parseHome(v: string): HomeSpec {
  if (v.startsWith("t:")) return { teamId: v.slice(2) };
  if (v.startsWith("d:")) return { departmentId: v.slice(2) };
  return {};
}

function issuesMessage(err: unknown): string {
  if (!isDomainError(err)) return "";
  const issues = (err.details as { issues?: unknown } | undefined)?.issues;
  if (!Array.isArray(issues) || !issues.length) return "";
  const lines = issues
    .slice(0, 5)
    .map((i) => (i && typeof i === "object" ? `${(i as { path?: string }).path ? `${(i as { path?: string }).path}: ` : ""}${(i as { message?: string }).message ?? ""}` : String(i)));
  return ` ${lines.join("; ")}${issues.length > 5 ? ` (and ${issues.length - 5} more)` : ""}`;
}

/**
 * Create a draft from one start option, then open the editor. Nothing is
 * published here; every evidence item arrives as a candidate.
 */
export async function createBriefAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const company = field(fd, "company");
  const start = field(fd, "start");
  const title = field(fd, "title");
  const audience = parseAudience(field(fd, "audience"));
  if (!audience) return { status: "error", code: "validation", message: "Choose who can read this briefing once it is published." };
  const home = parseHome(field(fd, "home"));

  let destination: string;
  try {
    const ws = await getRequestContext(company);
    const base = { home, audience, ...(title ? { title } : {}) };
    if (start === "blank") {
      const res = await createBriefing(ws.db, ws.ctx, { ...base, document: blankDocument(title) });
      destination = briefingPaths.edit(ws.org.slug, res.slug);
    } else if (start === "markdown") {
      const markdown = String(fd.get("markdown") ?? "");
      if (!markdown.trim()) return { status: "error", code: "validation", message: "Paste some Markdown to start from." };
      const res = await createBriefing(ws.db, ws.ctx, { ...base, markdown });
      destination = briefingPaths.edit(ws.org.slug, res.slug);
    } else if (start === "handoff") {
      const raw = String(fd.get("handoff") ?? "");
      let handoff: unknown;
      try {
        handoff = JSON.parse(raw);
      } catch {
        return { status: "error", code: "validation", message: "The handoff isn't valid JSON." };
      }
      const res = await createBriefing(ws.db, ws.ctx, { ...base, handoff });
      destination = briefingPaths.edit(ws.org.slug, res.slug);
    } else if (start === "upload") {
      const file = fd.get("file");
      if (!(file instanceof File) || file.size === 0) return { status: "error", code: "validation", message: "Choose a file to upload." };
      const kind = uploadKind(file);
      if (!kind) return { status: "error", code: "validation", message: "Upload a PDF, Word (.docx), PowerPoint (.pptx), Markdown or text file." };
      const bytes = new Uint8Array(await file.arrayBuffer());
      const docTitle = title || file.name.replace(/\.[^.]+$/, "").slice(0, 200) || undefined;
      // Text and Markdown compose synchronously (a # heading names the brief unless a title was given);
      // binary formats extract in the background: the draft starts blank and is composed from the
      // extracted passages (as candidate evidence) once extraction finishes, unless the author has
      // already written in it. The editor also offers "Draft from this source".
      const text = kind === "markdown" || kind === "text" ? new TextDecoder("utf-8", { fatal: false }).decode(bytes) : null;
      const created = text?.trim()
        ? await createBriefing(ws.db, ws.ctx, { home, audience, markdown: text, ...(title ? { title } : {}) })
        : await createBriefing(ws.db, ws.ctx, { home, audience, document: blankDocument(docTitle), ...(docTitle ? { title: docTitle } : {}) });
      try {
        const source = await addSource(ws.db, ws.ctx, {
          briefingId: created.briefingId,
          kind,
          title: file.name.slice(0, 300),
          filename: file.name.slice(0, 255),
          bytes,
          origin: "upload",
          ...(text === null ? { composeDraft: true } : {}),
        });
        destination = briefingPaths.edit(ws.org.slug, created.slug, { source: source.sourceId });
      } catch (err) {
        // The draft exists; say the file was not attached rather than losing the draft.
        if (!isDomainError(err)) throw err;
        destination = briefingPaths.edit(ws.org.slug, created.slug, { upload: err.code === "validation" ? "rejected" : "failed" });
      }
    } else {
      return { status: "error", code: "validation", message: "Choose how to start." };
    }
  } catch (err) {
    if (isDomainError(err)) {
      return {
        status: "error",
        code: err.code,
        message: err.code === "validation" ? `${err.message || errorMessage("validation")}${issuesMessage(err)}` : errorMessage(err.code),
      };
    }
    throw err;
  }
  redirect(destination);
}
