import { GetObjectCommand, PutObjectCommand, S3Client, type ServerSideEncryption } from "@aws-sdk/client-s3";
import { parseSourceKey, sourceKeyFor, verifySourceBytes, type SourceStore } from "./object-key";

/**
 * S3-compatible source store. No vendor is assumed: endpoint, region, bucket
 * and credentials always come from configuration.
 *
 * - Object key: `<prefix><organizationId>/<sha256>`. The key recorded on the
 *   `sources` row stays `<organizationId>/<sha256>`, so rows do not depend on
 *   the backend or prefix.
 * - Private bucket: no ACL is ever sent, so objects inherit the bucket's
 *   private default. Bytes are never served from the bucket directly; reads go
 *   through domain services after an access check.
 * - Immutable: puts send `If-None-Match: *`. A 412 means the object already
 *   exists, and since the key is the content hash that is success. (A service
 *   that ignores the header overwrites with identical bytes.)
 * - Integrity: `get` verifies the sha256 in the key, so tampering is detected.
 * - Optional server-side encryption (`AES256` or `aws:kms` with a key id).
 */
export interface S3SourceStoreConfig {
  bucket: string;
  region: string;
  endpoint: string;
  forcePathStyle: boolean;
  /** "" or a normalized prefix ending in "/" (see `normalizePrefix`). */
  prefix: string;
  serverSideEncryption?: ServerSideEncryption;
  sseKmsKeyId?: string;
  /** Explicit credentials; when absent the SDK's default provider chain is used. */
  credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
}

const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const PREFIX_SEGMENT = /^[A-Za-z0-9._-]+$/;
const SSE_MODES: readonly string[] = ["AES256", "aws:kms"];

/** Normalize an optional key prefix to "" or `a/b/`. Rejects traversal and unusual characters. */
export function normalizePrefix(raw: string | undefined): string {
  const trimmed = (raw ?? "").trim().replace(/^\/+|\/+$/g, "");
  if (!trimmed) return "";
  const segments = trimmed.split("/");
  for (const s of segments) {
    if (!PREFIX_SEGMENT.test(s) || s === "." || s === "..") throw new Error("CEREBRO_S3_PREFIX may contain only letters, digits, '.', '_', '-' and '/' separators, with no '.' or '..' segments.");
  }
  return `${segments.join("/")}/`;
}

function parseBool(name: string, raw: string | undefined, errors: string[]): boolean {
  const v = raw?.trim().toLowerCase();
  if (!v || v === "false" || v === "0") return false;
  if (v === "true" || v === "1") return true;
  errors.push(`${name} must be "true" or "false"`);
  return false;
}

/**
 * Read and validate S3 configuration. Throws one error listing every problem.
 * Messages name variables only, never their values (credentials stay out of logs).
 */
export function s3ConfigFromEnv(env: NodeJS.ProcessEnv = process.env): S3SourceStoreConfig {
  const errors: string[] = [];
  const get = (name: string) => env[name]?.trim() || undefined;

  const bucket = get("CEREBRO_S3_BUCKET");
  if (!bucket) errors.push("CEREBRO_S3_BUCKET is required");
  else if (!BUCKET.test(bucket)) errors.push("CEREBRO_S3_BUCKET is not a valid bucket name");

  const region = get("CEREBRO_S3_REGION");
  if (!region) errors.push("CEREBRO_S3_REGION is required");

  const endpoint = get("CEREBRO_S3_ENDPOINT");
  if (!endpoint) errors.push("CEREBRO_S3_ENDPOINT is required (no provider endpoint is assumed)");
  else {
    let url: URL | undefined;
    try {
      url = new URL(endpoint);
    } catch {
      url = undefined;
    }
    if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) errors.push("CEREBRO_S3_ENDPOINT must be an http(s) URL");
    else if (url.username || url.password) errors.push("CEREBRO_S3_ENDPOINT must not embed credentials");
  }

  const forcePathStyle = parseBool("CEREBRO_S3_FORCE_PATH_STYLE", env.CEREBRO_S3_FORCE_PATH_STYLE, errors);

  let prefix = "";
  try {
    prefix = normalizePrefix(env.CEREBRO_S3_PREFIX);
  } catch (err) {
    errors.push((err as Error).message);
  }

  const sse = get("CEREBRO_S3_SSE");
  const sseKmsKeyId = get("CEREBRO_S3_SSE_KMS_KEY_ID");
  if (sse && !SSE_MODES.includes(sse)) errors.push(`CEREBRO_S3_SSE must be one of ${SSE_MODES.join(", ")}`);
  if (sseKmsKeyId && sse !== "aws:kms") errors.push("CEREBRO_S3_SSE_KMS_KEY_ID requires CEREBRO_S3_SSE=aws:kms");

  const accessKeyId = get("AWS_ACCESS_KEY_ID");
  const secretAccessKey = get("AWS_SECRET_ACCESS_KEY");
  const sessionToken = get("AWS_SESSION_TOKEN");
  if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) errors.push("AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set together");

  if (errors.length) throw new Error(`CEREBRO_OBJECT_STORE=s3 is misconfigured: ${errors.join("; ")}.`);

  return {
    bucket: bucket!,
    region: region!,
    endpoint: endpoint!,
    forcePathStyle,
    prefix,
    ...(sse ? { serverSideEncryption: sse as ServerSideEncryption } : {}),
    ...(sseKmsKeyId ? { sseKmsKeyId } : {}),
    ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) } } : {}),
  };
}

const statusOf = (err: unknown): number | undefined => (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
const nameOf = (err: unknown): string | undefined => (err as { name?: string }).name;

export class S3SourceStore implements SourceStore {
  readonly config: S3SourceStoreConfig;
  readonly client: S3Client;

  constructor(config: S3SourceStoreConfig, client?: S3Client) {
    if (!BUCKET.test(config.bucket)) throw new Error("invalid bucket name");
    if (normalizePrefix(config.prefix) !== config.prefix) throw new Error("invalid object key prefix");
    this.config = config;
    this.client =
      client ??
      new S3Client({
        region: config.region,
        endpoint: config.endpoint,
        forcePathStyle: config.forcePathStyle,
        ...(config.credentials ? { credentials: config.credentials } : {}),
        // Portability across S3-compatible services: send only checksums the
        // operation requires. Integrity is enforced by the content-hash key.
        requestChecksumCalculation: "WHEN_REQUIRED",
        responseChecksumValidation: "WHEN_REQUIRED",
      });
  }

  /** Bucket object key for a validated source key. */
  objectKey(key: string): string {
    return `${this.config.prefix}${parseSourceKey(key).key}`;
  }

  async put(organizationId: string, bytes: Uint8Array): Promise<{ key: string; sha256: string }> {
    const key = sourceKeyFor(organizationId, bytes);
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: this.objectKey(key.key),
          Body: bytes,
          ContentLength: bytes.byteLength,
          ContentType: "application/octet-stream",
          IfNoneMatch: "*",
          ...(this.config.serverSideEncryption ? { ServerSideEncryption: this.config.serverSideEncryption } : {}),
          ...(this.config.sseKmsKeyId ? { SSEKMSKeyId: this.config.sseKmsKeyId } : {}),
        }),
      );
    } catch (err) {
      // Same key means same content: an existing object is fine.
      if (statusOf(err) !== 412 && nameOf(err) !== "PreconditionFailed") throw err;
    }
    return { key: key.key, sha256: key.sha256 };
  }

  async get(organizationId: string, key: string): Promise<Uint8Array> {
    const parsed = parseSourceKey(key, organizationId);
    let bytes: Uint8Array;
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: this.objectKey(parsed.key) }));
      if (!res.Body) throw new Error("source object has no body");
      bytes = await res.Body.transformToByteArray();
    } catch (err) {
      if (statusOf(err) === 404 || nameOf(err) === "NoSuchKey") throw new Error("source object not found");
      throw err;
    }
    return verifySourceBytes(parsed, bytes);
  }
}
