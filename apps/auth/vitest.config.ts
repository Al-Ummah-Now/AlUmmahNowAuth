import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        // Don't use wrangler config to avoid loading the main worker
        // This prevents OpenAuth issuer from being imported during tests
        miniflare: {
          // Add D1 database binding for testing
          d1Databases: ["AUTH_DB"],
          // Add KV namespace binding for testing
          kvNamespaces: ["AUTH_STORAGE"],
          // Enable nodejs_compat for node:* imports in dependencies
          compatibilityFlags: ["nodejs_compat"],
          // Set a compatibility date
          compatibilityDate: "2024-12-30",
        },
      },
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.spec.ts",
        "src/index.ts", // Main worker entry point - integration tested
        "src/auth-client.ts", // Client code - tested separately
      ],
    },
  },
});
