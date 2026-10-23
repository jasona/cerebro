import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizePrefix, s3ConfigFromEnv, S3SourceStore, type S3SourceStoreConfig } from "./s3-store";
import { assertSourceStoreConfig, createSourceStoreFromEnv, LocalSourceStore, objectStoreKind, parseSourceKey, sha256Hex } from "./store";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const BYTES = new TextEncoder().encode("quarterly plan v1");
const SHA = sha256Hex(BYTES);

const S3_ENV = {
  CEREBRO_OBJECT_STORE: "s3",
  CEREBRO_S3_ENDPOINT: "http://127.0.0.1:9100",
  CEREBRO_S3_REGION: "test-region",
  CEREBRO_S3_BUCKET: "cerebro-sources",
};

describe("source object keys", () => {
  it("accepts exactly <org uuid>/<sha256>", () => {
    expect(parseSourceKey(`${ORG_A}/${SHA}`)).toEqual({ key: `${ORG_A}/${SHA}`, organizationId: ORG_A, sha256: SHA });
  });

  it.each([
    ["traversal", `${ORG_A}/../${ORG_B}/${SHA}`],
    ["leading slash", `/${ORG_A}/${SHA}`],
    ["extra segment", `${ORG_A}/x/${SHA}`],
    ["prefix", `tenants/${ORG_A}/${SHA}`],
    ["not a uuid", `------------------------------------/${SHA}`],
    ["short hash", `${ORG_A}/${SHA.slice(1)}`],
    ["uppercase", `${ORG_A}/${SHA.toUpperCase()}`],
    ["empty", ""],
    ["backslash", `${ORG_A}\\${SHA}`],
  ])("rejects %s", (_name, key) => {
    expect(() => parseSourceKey(key)).toThrow("invalid source object key");
  });

  it("enforces the tenant prefix", () => {
    expect(() => parseSourceKey(`${ORG_A}/${SHA}`, ORG_B)).toThrow("another organization");
    expect(() => parseSourceKey(`${ORG_A}/${SHA}`, "not-a-uuid")).toThrow("invalid organization id");
    expect(parseSourceKey(`${ORG_A}/${SHA}`, ORG_A.toUpperCase()).organizationId).toBe(ORG_A);
  });
});

describe("LocalSourceStore", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cerebro-objects-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("roundtrips, re-puts idempotently, rejects cross-tenant reads and detects tampering", async () => {
    const store = new LocalSourceStore(root);
    const put = await store.put(ORG_A, BYTES);
    expect(put).toEqual({ key: `${ORG_A}/${SHA}`, sha256: SHA });
    expect(await store.put(ORG_A, BYTES)).toEqual(put);
    expect(await store.get(ORG_A, put.key)).toEqual(BYTES);
    await expect(store.get(ORG_B, put.key)).rejects.toThrow("another organization");
    await expect(store.get(ORG_A, `${ORG_A}/../${ORG_B}/${SHA}`)).rejects.toThrow("invalid source object key");
    await writeFile(join(root, ORG_A, SHA), "tampered");
    await expect(store.get(ORG_A, put.key)).rejects.toThrow("integrity");
    expect(await readdir(root)).toEqual([ORG_A]);
  });

  it("rejects an invalid organization id on put", async () => {
    await expect(new LocalSourceStore(root).put("../etc", BYTES)).rejects.toThrow("invalid organization id");
  });
});

describe("store factory", () => {
  it("defaults to the local store", () => {
    expect(objectStoreKind({})).toBe("local");
    expect(objectStoreKind({ CEREBRO_OBJECT_STORE: " Local " })).toBe("local");
    expect(createSourceStoreFromEnv({ CEREBRO_OBJECTS_DIR: "/tmp/cerebro-x" })).toBeInstanceOf(LocalSourceStore);
    expect(assertSourceStoreConfig({})).toBe("local");
  });

  it("rejects an unknown adapter", () => {
    expect(() => objectStoreKind({ CEREBRO_OBJECT_STORE: "gcs" })).toThrow('CEREBRO_OBJECT_STORE must be "local" or "s3"');
  });

  it("builds the S3 store from configuration", () => {
    const store = createSourceStoreFromEnv({ ...S3_ENV, CEREBRO_S3_PREFIX: "/cerebro/sources/", CEREBRO_S3_FORCE_PATH_STYLE: "true" });
    expect(store).toBeInstanceOf(S3SourceStore);
    const s3 = store as S3SourceStore;
    expect(s3.config).toMatchObject({ bucket: "cerebro-sources", region: "test-region", endpoint: "http://127.0.0.1:9100", forcePathStyle: true, prefix: "cerebro/sources/" });
    expect(s3.config.credentials).toBeUndefined();
    expect(s3.objectKey(`${ORG_A}/${SHA}`)).toBe(`cerebro/sources/${ORG_A}/${SHA}`);
    expect(() => s3.objectKey(`../${SHA}`)).toThrow("invalid source object key");
  });

  it("fails fast listing every missing setting, without echoing values", () => {
    const run = () => assertSourceStoreConfig({ CEREBRO_OBJECT_STORE: "s3", AWS_ACCESS_KEY_ID: "AKIDSECRETVALUE" });
    expect(run).toThrow(/CEREBRO_S3_BUCKET is required.*CEREBRO_S3_REGION is required.*CEREBRO_S3_ENDPOINT is required.*AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set together/);
    expect(run).not.toThrow(/AKIDSECRETVALUE/);
    expect(() => createSourceStoreFromEnv({ CEREBRO_OBJECT_STORE: "s3" })).toThrow("misconfigured");
  });

  it.each([
    ["bad endpoint", { CEREBRO_S3_ENDPOINT: "ftp://example.test" }, "must be an http(s) URL"],
    ["endpoint credentials", { CEREBRO_S3_ENDPOINT: "https://u:p@example.test" }, "must not embed credentials"],
    ["bad bucket", { CEREBRO_S3_BUCKET: "Bad_Bucket" }, "not a valid bucket name"],
    ["bad path style", { CEREBRO_S3_FORCE_PATH_STYLE: "yes" }, "CEREBRO_S3_FORCE_PATH_STYLE"],
    ["traversal prefix", { CEREBRO_S3_PREFIX: "a/../b" }, "CEREBRO_S3_PREFIX"],
    ["bad sse", { CEREBRO_S3_SSE: "rot13" }, "CEREBRO_S3_SSE must be one of"],
    ["kms key without kms", { CEREBRO_S3_SSE: "AES256", CEREBRO_S3_SSE_KMS_KEY_ID: "k" }, "requires CEREBRO_S3_SSE=aws:kms"],
  ])("rejects %s", (_name, override, message) => {
    expect(() => s3ConfigFromEnv({ ...S3_ENV, ...override })).toThrow(message);
  });

  it("reads credentials and encryption settings", () => {
    const cfg = s3ConfigFromEnv({
      ...S3_ENV,
      AWS_ACCESS_KEY_ID: "id",
      AWS_SECRET_ACCESS_KEY: "secret",
      AWS_SESSION_TOKEN: "token",
      CEREBRO_S3_SSE: "aws:kms",
      CEREBRO_S3_SSE_KMS_KEY_ID: "key-1",
    });
    expect(cfg.credentials).toEqual({ accessKeyId: "id", secretAccessKey: "secret", sessionToken: "token" });
    expect(cfg).toMatchObject({ serverSideEncryption: "aws:kms", sseKmsKeyId: "key-1" });
  });

  it("prefers CEREBRO_S3_* credentials over AWS_* (external store override)", () => {
    const both = { ...S3_ENV, AWS_ACCESS_KEY_ID: "in-stack", AWS_SECRET_ACCESS_KEY: "in-stack-secret", AWS_SESSION_TOKEN: "t" };
    expect(s3ConfigFromEnv({ ...both, CEREBRO_S3_ACCESS_KEY_ID: "ext", CEREBRO_S3_SECRET_ACCESS_KEY: "ext-secret" }).credentials).toEqual({
      accessKeyId: "ext",
      secretAccessKey: "ext-secret",
    });
    expect(s3ConfigFromEnv({ ...both, CEREBRO_S3_ACCESS_KEY_ID: "", CEREBRO_S3_SECRET_ACCESS_KEY: "" }).credentials?.accessKeyId).toBe("in-stack");
    const half = () => s3ConfigFromEnv({ ...both, CEREBRO_S3_ACCESS_KEY_ID: "EXTKEYVALUE" });
    expect(half).toThrow("CEREBRO_S3_ACCESS_KEY_ID and CEREBRO_S3_SECRET_ACCESS_KEY must be set together");
    expect(half).not.toThrow(/EXTKEYVALUE/);
  });

  it("normalizes prefixes", () => {
    expect(normalizePrefix(undefined)).toBe("");
    expect(normalizePrefix(" / ")).toBe("");
    expect(normalizePrefix("a/b")).toBe("a/b/");
    expect(() => normalizePrefix("a//b")).toThrow();
    expect(() => normalizePrefix("./a")).toThrow();
  });
});

describe("S3SourceStore requests", () => {
  const config: S3SourceStoreConfig = { ...s3ConfigFromEnv(S3_ENV), prefix: "p/", serverSideEncryption: "AES256" };
  const fakeClient = (handler: (cmd: unknown) => unknown) => {
    const sent: unknown[] = [];
    const client = {
      send: async (cmd: unknown) => {
        sent.push(cmd);
        return handler(cmd);
      },
    } as unknown as S3Client;
    return { client, sent };
  };
  const preconditionFailed = Object.assign(new Error("precondition"), { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } });

  it("puts immutably, privately and encrypted", async () => {
    const { client, sent } = fakeClient(() => ({}));
    const store = new S3SourceStore(config, client);
    expect(await store.put(ORG_A, BYTES)).toEqual({ key: `${ORG_A}/${SHA}`, sha256: SHA });
    const cmd = sent[0] as PutObjectCommand;
    expect(cmd).toBeInstanceOf(PutObjectCommand);
    expect(cmd.input).toMatchObject({ Bucket: "cerebro-sources", Key: `p/${ORG_A}/${SHA}`, IfNoneMatch: "*", ServerSideEncryption: "AES256" });
    expect(cmd.input.ACL).toBeUndefined();
    expect(cmd.input.Metadata).toBeUndefined();
  });

  it("treats 412 on an existing key as success and rethrows other errors", async () => {
    await expect(new S3SourceStore(config, fakeClient(() => Promise.reject(preconditionFailed)).client).put(ORG_A, BYTES)).resolves.toEqual({ key: `${ORG_A}/${SHA}`, sha256: SHA });
    const denied = Object.assign(new Error("denied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } });
    await expect(new S3SourceStore(config, fakeClient(() => Promise.reject(denied)).client).put(ORG_A, BYTES)).rejects.toThrow("denied");
  });

  it("verifies content and tenant on get without contacting the bucket for foreign keys", async () => {
    const body = (b: Uint8Array) => ({ Body: { transformToByteArray: async () => b } });
    const ok = fakeClient(() => body(BYTES));
    expect(await new S3SourceStore(config, ok.client).get(ORG_A, `${ORG_A}/${SHA}`)).toEqual(BYTES);
    expect((ok.sent[0] as GetObjectCommand).input).toEqual({ Bucket: "cerebro-sources", Key: `p/${ORG_A}/${SHA}` });

    const tampered = fakeClient(() => body(new TextEncoder().encode("tampered")));
    await expect(new S3SourceStore(config, tampered.client).get(ORG_A, `${ORG_A}/${SHA}`)).rejects.toThrow("integrity");

    const foreign = fakeClient(() => body(BYTES));
    await expect(new S3SourceStore(config, foreign.client).get(ORG_B, `${ORG_A}/${SHA}`)).rejects.toThrow("another organization");
    expect(foreign.sent).toHaveLength(0);

    const missing = fakeClient(() => Promise.reject(Object.assign(new Error("nope"), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } })));
    await expect(new S3SourceStore(config, missing.client).get(ORG_A, `${ORG_A}/${SHA}`)).rejects.toThrow("source object not found");
  });

  it("refuses an unnormalized prefix", () => {
    expect(() => new S3SourceStore({ ...config, prefix: "../" })).toThrow();
  });
});
