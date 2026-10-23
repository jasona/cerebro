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
  serverExternalPackages: ["@electric-sql/pglite", "@electric-sql/pglite-pgvector", "pg", "mammoth", "unpdf", "jszip", "@aws-sdk/client-s3"],
  poweredByHeader: false,
  experimental: { serverActions: { bodySizeLimit: "20mb" } },
};

export default config;
