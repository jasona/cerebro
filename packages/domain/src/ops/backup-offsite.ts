import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { HeadObjectCommand, PutObjectCommand, S3Client, type ServerSideEncryption } from "@aws-sdk/client-s3";
import { normalizePrefix } from "../sources/s3-store";

/**
 * Optional off-site copy of a finished backup directory (D26) to any
 * S3-compatible bucket: Coolify's S3 backup destination or another
 * S3-compatible target. Configured only through the environment:
 *
 *   CEREBRO_BACKUP_S3_ENDPOINT, CEREBRO_BACKUP_S3_BUCKET (required to enable),
 *   CEREBRO_BACKUP_S3_ACCESS_KEY_ID, CEREBRO_BACKUP_S3_SECRET_ACCESS_KEY (required),
 *   CEREBRO_BACKUP_S3_REGION (default us-east-1, a nominal value for services
 *   that ignore regions), CEREBRO_BACKUP_S3_FORCE_PATH_STYLE (default false),
 *   CEREBRO_BACKUP_S3_PREFIX (default `cerebro-backups`), CEREBRO_BACKUP_S3_SSE
 *   (optional: AES256 or aws:kms).
 *
 * Files are uploaded one by one to `<prefix>/<backup directory name>/<path>`
 * (the directory name is the backup's UTC timestamp), `manifest.json` last, so
 * a copy with a manifest is complete. Each upload is checked by size with a
 * HEAD request. Credentials are passed to the SDK only, never logged or put
 * on a command line; errors name variables, not values. Pruning off-site
 * copies is left to the destination's lifecycle rules.
 */
export interface OffsiteConfig {
  endpoint: string;
  region: string;
  bucket: string;
  forcePathStyle: boolean;
  prefix: string;
  credentials: { accessKeyId: string; secretAccessKey: string };
  serverSideEncryption?: ServerSideEncryption;
}

const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

/** `null` when no off-site destination is configured; throws (naming variables only) when it is half-configured. */
export function offsiteConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OffsiteConfig | null {
  const get = (name: string) => env[`CEREBRO_BACKUP_S3_${name}`]?.trim() || undefined;
  const endpoint = get("ENDPOINT");
  const bucket = get("BUCKET");
  const accessKeyId = get("ACCESS_KEY_ID");
  const secretAccessKey = get("SECRET_ACCESS_KEY");
  if (!endpoint && !bucket && !accessKeyId && !secretAccessKey) return null;

  const errors: string[] = [];
  if (!endpoint) errors.push("CEREBRO_BACKUP_S3_ENDPOINT is required");
  else {
    let url: URL | undefined;
    try {
      url = new URL(endpoint);
    } catch {
      url = undefined;
    }
    if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) errors.push("CEREBRO_BACKUP_S3_ENDPOINT must be an http(s) URL");
    else if (url.username || url.password) errors.push("CEREBRO_BACKUP_S3_ENDPOINT must not embed credentials");
  }
  if (!bucket) errors.push("CEREBRO_BACKUP_S3_BUCKET is required");
  else if (!BUCKET.test(bucket)) errors.push("CEREBRO_BACKUP_S3_BUCKET is not a valid bucket name");
  if (!accessKeyId || !secretAccessKey) errors.push("CEREBRO_BACKUP_S3_ACCESS_KEY_ID and CEREBRO_BACKUP_S3_SECRET_ACCESS_KEY are required");
  const pathStyle = get("FORCE_PATH_STYLE")?.toLowerCase();
  if (pathStyle && !["true", "false", "1", "0"].includes(pathStyle)) errors.push('CEREBRO_BACKUP_S3_FORCE_PATH_STYLE must be "true" or "false"');
  const sse = get("SSE");
  if (sse && sse !== "AES256" && sse !== "aws:kms") errors.push("CEREBRO_BACKUP_S3_SSE must be one of AES256, aws:kms");
  let prefix = "";
  try {
    prefix = normalizePrefix(get("PREFIX") ?? "cerebro-backups");
  } catch {
    errors.push("CEREBRO_BACKUP_S3_PREFIX may contain only letters, digits, '.', '_', '-' and '/' separators");
  }
  if (errors.length) throw new Error(`Off-site backup is misconfigured: ${errors.join("; ")}.`);
  return {
    endpoint: endpoint!,
    region: get("REGION") ?? "us-east-1",
    bucket: bucket!,
    forcePathStyle: pathStyle === "true" || pathStyle === "1",
    prefix,
    credentials: { accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey! },
    ...(sse ? { serverSideEncryption: sse as ServerSideEncryption } : {}),
  };
}

export function offsiteClient(config: OffsiteConfig): S3Client {
  return new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle,
    credentials: config.credentials,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) out.push(join(entry.parentPath, entry.name));
  }
  return out;
}

/** Upload a finished backup directory. Returns where it went and how much was sent. */
export async function uploadBackupOffsite(
  dir: string,
  config: OffsiteConfig,
  client: S3Client = offsiteClient(config),
): Promise<{ bucket: string; prefix: string; files: number; bytes: number }> {
  const root = resolve(dir);
  const name = basename(root);
  const files = await listFiles(root);
  const manifest = join(root, "manifest.json");
  if (!files.includes(manifest)) throw new Error("not a complete backup: manifest.json is missing");
  // Manifest last: a copy that has one is complete.
  const ordered = [...files.filter((f) => f !== manifest).sort(), manifest];
  const keyPrefix = `${config.prefix}${name}/`;
  let bytes = 0;
  for (const file of ordered) {
    const size = (await stat(file)).size;
    const Key = keyPrefix + relative(root, file).split(sep).join("/");
    await client.send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key,
        Body: createReadStream(file),
        ContentLength: size,
        ContentType: "application/octet-stream",
        ...(config.serverSideEncryption ? { ServerSideEncryption: config.serverSideEncryption } : {}),
      }),
    );
    const head = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key }));
    if (head.ContentLength !== size) throw new Error(`off-site copy of ${relative(root, file)} has the wrong size`);
    bytes += size;
  }
  return { bucket: config.bucket, prefix: keyPrefix, files: ordered.length, bytes };
}
