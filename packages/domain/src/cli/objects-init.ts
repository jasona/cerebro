/**
 * `npm run objects:init`: with `CEREBRO_OBJECT_STORE=s3`, make sure the
 * source bucket exists (HeadBucket, then CreateBucket; "already exists" is
 * success). Idempotent; runs in the one-shot `migrate` step on Coolify
 * (deploy/docker/migrate.sh). With the local store it does nothing.
 */
import { ensureBucket, S3SourceStore, s3ConfigFromEnv } from "../sources/s3-store";
import { objectStoreKind } from "../sources/store";

try {
  if (objectStoreKind() !== "s3") {
    console.log("Object store is local; no bucket to prepare.");
  } else {
    const store = new S3SourceStore(s3ConfigFromEnv());
    const result = await ensureBucket(store);
    console.log(`Bucket ${store.config.bucket} ${result === "created" ? "created" : "already exists"}.`);
  }
} catch (err) {
  const e = err as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
  const status = e.$metadata?.httpStatusCode ? ` (HTTP ${e.$metadata.httpStatusCode})` : "";
  console.error(`objects:init failed${status}: ${e.name ?? "Error"}: ${e.message ?? String(err)}`);
  process.exit(1);
}
