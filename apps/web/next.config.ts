import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// Monorepo root: internal packages and hoisted node_modules live above apps/web.
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

const config: NextConfig = {
  // Self-contained server (`.next/standalone`) for the production image
  // (deploy/web.Dockerfile). Has no effect on `next dev`.
  output: "standalone",
  outputFileTracingRoot: repoRoot,
  transpilePackages: [
    "@cerebro/briefing-schema",
    "@cerebro/briefing-renderer",
    "@cerebro/ui",
    "@cerebro/domain",
    "@cerebro/database",
    "@cerebro/ai",
    "@cerebro/capture",
    "@cerebro/integrations",
  ],
  // Native/WASM server dependencies are loaded from node_modules at runtime.
  serverExternalPackages: [
    "@electric-sql/pglite",
    "@electric-sql/pglite-pgvector",
    "pg",
    "mammoth",
    "unpdf",
    "jszip",
    // OCR: WASM in a worker thread, bundled language data located via __dirname, and a prebuilt native canvas.
    "tesseract.js",
    "tesseract.js-core",
    "@tesseract.js-data/eng",
    "@napi-rs/canvas",
    "@aws-sdk/client-s3",
    "@anthropic-ai/sdk",
  ],
  poweredByHeader: false,
  experimental: { serverActions: { bodySizeLimit: "20mb" } },
};

export default config;
