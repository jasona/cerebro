/**
 * Production-path security review follow-ups for source deletion and
 * retention. Each test exercises the real domain services under the runtime
 * role; the system context is used only to inspect state.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sources } from "@cerebro/database";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteSource } from "../../src/ops/index";
import { addSource, LocalSourceStore, setSourceStore, type SourceStore } from "../../src/sources/index";
import { createTestWorld, type TestWorld } from "../../src/testing";
import { sys } from "./helpers";

let w: TestWorld;
let objects: string;
beforeEach(async () => {
  w = await createTestWorld();
  objects = await mkdtemp(join(tmpdir(), "cerebro-sec-retention-"));
});
afterEach(async () => {
  setSourceStore(undefined);
  await w.h.close();
  await rm(objects, { recursive: true, force: true });
});

const BYTES = new TextEncoder().encode("# Shared memo\n\nIdentical bytes uploaded twice share one content-addressed object.");

describe("content-addressed objects under concurrent deletion", () => {
  it("a source added while another source with the same bytes is being deleted keeps its object", async () => {
    const local = new LocalSourceStore(objects);
    let concurrent: Promise<{ sourceId: string }> | null = null;
    // Interleave a second upload of the same bytes right before the deleted
    // source's object is removed, as a concurrent request would.
    const racing: SourceStore = {
      put: (org, bytes) => local.put(org, bytes),
      get: (org, key) => local.get(org, key),
      async delete(org, key) {
        concurrent ??= addSource(w.h.db, w.ctx("alex"), { kind: "markdown", bytes: BYTES, origin: "upload" });
        await Promise.race([concurrent, new Promise((r) => setTimeout(r, 300))]);
        return local.delete(org, key);
      },
    };
    setSourceStore(racing);

    const first = await addSource(w.h.db, w.ctx("maya"), { kind: "markdown", bytes: BYTES, origin: "upload" });
    await deleteSource(w.h.db, w.ctx("maya"), { sourceId: first.sourceId });
    expect(concurrent).not.toBeNull();
    const second = await concurrent!;

    const [row] = await sys(w, (tx) => tx.select({ objectKey: sources.objectKey }).from(sources).where(eq(sources.id, second.sourceId)));
    expect(row?.objectKey).toBeTruthy();
    // The surviving source's original must still be readable.
    await expect(local.get(w.seed.orgs.acme.id, row!.objectKey!)).resolves.toEqual(BYTES);
  });
});
