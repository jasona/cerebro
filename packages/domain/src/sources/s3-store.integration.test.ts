import { CreateBucketCommand, DeleteObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { sources, withSystemContext } from "@cerebro/database";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildDocx } from "../../../capture/test/fixtures";
import { drainJobs, makePublishedBriefing } from "../engagement/test-fixtures";
import { DomainError } from "../errors";
import { createTestWorld } from "../testing";
import { addSource, getSourceExtraction, setSourceStore } from "./index";
import { s3ConfigFromEnv, S3SourceStore } from "./s3-store";
import { sha256Hex } from "./store";

/**
 * Runs against a real S3-compatible server when TEST_S3_ENDPOINT is set
 * (e.g. a local MinIO); skipped otherwise. Settings:
 *   TEST_S3_ENDPOINT, TEST_S3_BUCKET (default cerebro-test), TEST_S3_REGION
 *   (default test-region), TEST_S3_ACCESS_KEY_ID, TEST_S3_SECRET_ACCESS_KEY,
 *   TEST_S3_FORCE_PATH_STYLE (default true).
 * The bucket is created if missing. Objects go under a unique per-run prefix.
 */
const endpoint = process.env.TEST_S3_ENDPOINT?.trim();
const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";

describe.skipIf(!endpoint)("S3SourceStore against a live S3-compatible server", () => {
  let store: S3SourceStore;
  const written: string[] = [];

  beforeAll(async () => {
    const config = s3ConfigFromEnv({
      CEREBRO_S3_ENDPOINT: endpoint,
      CEREBRO_S3_BUCKET: process.env.TEST_S3_BUCKET ?? "cerebro-test",
      CEREBRO_S3_REGION: process.env.TEST_S3_REGION ?? "test-region",
      CEREBRO_S3_FORCE_PATH_STYLE: process.env.TEST_S3_FORCE_PATH_STYLE ?? "true",
      CEREBRO_S3_PREFIX: `it-${Date.now()}-${process.pid}`,
      AWS_ACCESS_KEY_ID: process.env.TEST_S3_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: process.env.TEST_S3_SECRET_ACCESS_KEY,
    });
    store = new S3SourceStore(config);
    try {
      await store.client.send(new CreateBucketCommand({ Bucket: config.bucket }));
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name !== "BucketAlreadyOwnedByYou" && name !== "BucketAlreadyExists") throw err;
    }
  });

  afterAll(async () => {
    setSourceStore(undefined);
    for (const key of written) await store.client.send(new DeleteObjectCommand({ Bucket: store.config.bucket, Key: store.objectKey(key) }));
  });

  it("roundtrips bytes under the tenant key", async () => {
    const bytes = new TextEncoder().encode(`roundtrip ${Date.now()}`);
    const put = await store.put(ORG_A, bytes);
    written.push(put.key);
    expect(put).toEqual({ key: `${ORG_A}/${sha256Hex(bytes)}`, sha256: sha256Hex(bytes) });
    expect(await store.get(ORG_A, put.key)).toEqual(bytes);
  });

  it("re-puts the same content idempotently (If-None-Match: * returns 412)", async () => {
    const bytes = new TextEncoder().encode(`idempotent ${Date.now()}`);
    const first = await store.put(ORG_A, bytes);
    written.push(first.key);
    await expect(store.put(ORG_A, bytes)).resolves.toEqual(first);
    // A raw conditional put confirms the server enforces the precondition.
    await expect(
      store.client.send(new PutObjectCommand({ Bucket: store.config.bucket, Key: store.objectKey(first.key), Body: bytes, IfNoneMatch: "*" })),
    ).rejects.toMatchObject({ $metadata: { httpStatusCode: 412 } });
    expect(await store.get(ORG_A, first.key)).toEqual(bytes);
  });

  it("detects tampered objects", async () => {
    const bytes = new TextEncoder().encode(`tamper ${Date.now()}`);
    const put = await store.put(ORG_A, bytes);
    written.push(put.key);
    await store.client.send(new PutObjectCommand({ Bucket: store.config.bucket, Key: store.objectKey(put.key), Body: new TextEncoder().encode("tampered") }));
    await expect(store.get(ORG_A, put.key)).rejects.toThrow("integrity");
  });

  it("rejects cross-tenant and malformed keys", async () => {
    const bytes = new TextEncoder().encode(`tenant ${Date.now()}`);
    const put = await store.put(ORG_A, bytes);
    written.push(put.key);
    await expect(store.get(ORG_B, put.key)).rejects.toThrow("another organization");
    await expect(store.get(ORG_B, `${ORG_B}/../${put.key}`)).rejects.toThrow("invalid source object key");
    await expect(store.get(ORG_B, `${ORG_B}/${put.sha256}`)).rejects.toThrow("source object not found");
  });

  it("stores uploads and runs extraction through the domain services", async () => {
    const w = await createTestWorld();
    try {
      setSourceStore(store);
      const fb = await makePublishedBriefing(w);
      const bytes = await buildDocx(["Quarterly review of onboarding.", "Median time to value fell to 41 days."]);
      const src = await addSource(w.h.db, w.ctx("maya"), { briefingId: fb.id, kind: "docx", filename: "review.docx", bytes, origin: "upload" });
      const [row] = await withSystemContext(w.h.db, (tx) => tx.select().from(sources).where(eq(sources.id, src.sourceId)));
      expect(row!.objectKey).toBe(`${w.seed.orgs.acme.id}/${sha256Hex(bytes)}`);
      written.push(row!.objectKey!);
      expect(await store.get(w.seed.orgs.acme.id, row!.objectKey!)).toEqual(bytes);

      await drainJobs(w);
      const ex = await getSourceExtraction(w.h.db, w.ctx("maya"), src.sourceId);
      expect(ex.status).toBe("succeeded");
      expect(ex.chunks.map((c) => c.preview).join(" ")).toContain("41 days");

      // Another tenant cannot reach the source or its bytes.
      await expect(getSourceExtraction(w.h.db, w.ctx("taylor", "globex"), src.sourceId)).rejects.toBeInstanceOf(DomainError);
      await expect(store.get(w.seed.orgs.globex.id, row!.objectKey!)).rejects.toThrow("another organization");
    } finally {
      setSourceStore(undefined);
      await w.h.close();
    }
  });
});
