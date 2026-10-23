import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HeadObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { offsiteConfigFromEnv, uploadBackupOffsite } from "./backup-offsite";

const FULL = {
  CEREBRO_BACKUP_S3_ENDPOINT: "https://backups.example.test",
  CEREBRO_BACKUP_S3_BUCKET: "cerebro-offsite",
  CEREBRO_BACKUP_S3_ACCESS_KEY_ID: "OFFSITEKEYID",
  CEREBRO_BACKUP_S3_SECRET_ACCESS_KEY: "OFFSITESECRETVALUE",
};

describe("off-site backup configuration", () => {
  it("is off when nothing is set", () => {
    expect(offsiteConfigFromEnv({})).toBeNull();
  });

  it("reads a complete configuration with defaults", () => {
    expect(offsiteConfigFromEnv(FULL)).toEqual({
      endpoint: "https://backups.example.test",
      region: "us-east-1",
      bucket: "cerebro-offsite",
      forcePathStyle: false,
      prefix: "cerebro-backups/",
      credentials: { accessKeyId: "OFFSITEKEYID", secretAccessKey: "OFFSITESECRETVALUE" },
    });
    expect(offsiteConfigFromEnv({ ...FULL, CEREBRO_BACKUP_S3_PREFIX: "a/b", CEREBRO_BACKUP_S3_FORCE_PATH_STYLE: "true", CEREBRO_BACKUP_S3_SSE: "AES256" })).toMatchObject({
      prefix: "a/b/",
      forcePathStyle: true,
      serverSideEncryption: "AES256",
    });
  });

  it("refuses a half configuration, naming variables but never values", () => {
    const run = () => offsiteConfigFromEnv({ CEREBRO_BACKUP_S3_SECRET_ACCESS_KEY: "OFFSITESECRETVALUE", CEREBRO_BACKUP_S3_ENDPOINT: "https://u:p@x.test" });
    expect(run).toThrow(/must not embed credentials.*CEREBRO_BACKUP_S3_BUCKET is required.*ACCESS_KEY_ID and CEREBRO_BACKUP_S3_SECRET_ACCESS_KEY are required/);
    expect(run).not.toThrow(/OFFSITESECRETVALUE/);
    expect(() => offsiteConfigFromEnv({ ...FULL, CEREBRO_BACKUP_S3_PREFIX: "../x" })).toThrow("CEREBRO_BACKUP_S3_PREFIX");
  });
});

describe("off-site upload", () => {
  it("uploads every file under <prefix>/<backup name>/ with the manifest last, and checks sizes", async () => {
    const root = await mkdtemp(join(tmpdir(), "cerebro-offsite-"));
    try {
      const dir = join(root, "2026-10-23T03-00-00-000Z");
      await mkdir(join(dir, "objects", "org"), { recursive: true });
      await writeFile(join(dir, "manifest.json"), "{}");
      await writeFile(join(dir, "database.pgdump"), "dump");
      await writeFile(join(dir, "objects", "org", "abc"), "obj");
      const sent: string[] = [];
      const sizes = new Map<string, number>();
      const client = {
        send: async (cmd: unknown) => {
          if (cmd instanceof PutObjectCommand) {
            sent.push(cmd.input.Key!);
            sizes.set(cmd.input.Key!, cmd.input.ContentLength!);
            (cmd.input.Body as NodeJS.ReadableStream & { destroy(): void }).destroy();
            return {};
          }
          if (cmd instanceof HeadObjectCommand) return { ContentLength: sizes.get(cmd.input.Key!) };
          throw new Error("unexpected command");
        },
      } as unknown as S3Client;
      const config = offsiteConfigFromEnv(FULL)!;
      const res = await uploadBackupOffsite(dir, config, client);
      const p = "cerebro-backups/2026-10-23T03-00-00-000Z/";
      expect(sent).toEqual([`${p}database.pgdump`, `${p}objects/org/abc`, `${p}manifest.json`]);
      expect(res).toEqual({ bucket: "cerebro-offsite", prefix: p, files: 3, bytes: 9 });

      const short = {
        send: async (cmd: unknown) => {
          if (cmd instanceof HeadObjectCommand) return { ContentLength: 0 };
          ((cmd as PutObjectCommand).input.Body as { destroy(): void }).destroy();
          return {};
        },
      } as unknown as S3Client;
      await expect(uploadBackupOffsite(dir, config, short)).rejects.toThrow("wrong size");
      await rm(join(dir, "manifest.json"));
      await expect(uploadBackupOffsite(dir, config, client)).rejects.toThrow("manifest.json is missing");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
