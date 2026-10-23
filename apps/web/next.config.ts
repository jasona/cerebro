import type { NextConfig } from "next";

const config: NextConfig = {
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
<<<<<<< HEAD
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
  ],
=======
  serverExternalPackages: ["@electric-sql/pglite", "@electric-sql/pglite-pgvector", "pg", "mammoth", "unpdf", "jszip", "@aws-sdk/client-s3"],
>>>>>>> worktree-agent-a85a0080b9acbbce6
  poweredByHeader: false,
  experimental: { serverActions: { bodySizeLimit: "20mb" } },
};

export default config;
