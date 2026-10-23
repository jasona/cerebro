/**
 * CI smoke checks for source object storage (SeaweedFS in the compose stack,
 * D25) and object backups (D26). Runs in the worker container through tsx,
 * so it uses the same TypeScript store code as the app:
 *
 *   docker compose exec -T worker node --import tsx --input-type=module - put <orgId> < deploy/coolify/smoke-objects.mjs
 *   docker compose exec -T worker node --import tsx --input-type=module - backup <backupDir> <orgId> < deploy/coolify/smoke-objects.mjs
 *   docker compose exec -T worker node --import tsx --input-type=module - get <orgId> < deploy/coolify/smoke-objects.mjs
 *
 * `put`: store a known object through the configured store (`getSourceStore`,
 * immutable put) and confirm with a raw HEAD that it is in the bucket.
 * `backup`: the backup's manifest says S3 and the object file is present with
 * the right sha256. `get`: read the object back through the store (sha256
 * verified), e.g. from a bucket a restore wrote.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const root = process.cwd();
const { getSourceStore } = await import(join(root, "packages/domain/src/sources/store.ts"));
const { S3SourceStore } = await import(join(root, "packages/domain/src/sources/s3-store.ts"));
// Resolve the SDK the way the domain package does (no reliance on hoisting).
const { HeadObjectCommand } = createRequire(join(root, "packages/domain/package.json"))("@aws-sdk/client-s3");

const [mode, ...rest] = process.argv.slice(2);
const BYTES = new TextEncoder().encode("Cerebro smoke test source object\n");
const SHA = createHash("sha256").update(BYTES).digest("hex");

function check(ok, message) {
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
  if (!ok) process.exitCode = 1;
}

if (mode === "put") {
  const [org] = rest;
  const store = getSourceStore();
  check(store instanceof S3SourceStore, "the worker uses the S3 store");
  const put = await store.put(org, BYTES);
  check(put.key === `${org}/${SHA}`, `stored ${put.key}`);
  // A second put of the same bytes is accepted (If-None-Match: * -> 412 -> success).
  check((await store.put(org, BYTES)).key === put.key, "repeat put is idempotent");
  const head = await store.client.send(new HeadObjectCommand({ Bucket: store.config.bucket, Key: store.objectKey(put.key) }));
  check(head.ContentLength === BYTES.byteLength, `object is in bucket ${store.config.bucket} (${head.ContentLength} bytes)`);
} else if (mode === "backup") {
  const [dir, org] = rest;
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  check(manifest.objects?.store === "s3", `manifest objects from ${manifest.objects?.store}`);
  check(manifest.objects?.files >= 1, `manifest lists ${manifest.objects?.files} objects`);
  const bytes = readFileSync(join(dir, "objects", org, SHA));
  check(createHash("sha256").update(bytes).digest("hex") === SHA, "backup holds the smoke object with a matching sha256");
} else if (mode === "get") {
  const [org] = rest;
  const store = getSourceStore();
  const bytes = await store.get(org, `${org}/${SHA}`);
  check(Buffer.from(bytes).equals(Buffer.from(BYTES)), `read the smoke object back from bucket ${store.config.bucket}`);
} else {
  console.error("Usage: node --import tsx --input-type=module - <put|backup|get> ...");
  process.exitCode = 2;
}
