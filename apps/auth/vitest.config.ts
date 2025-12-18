import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    // Run test files sequentially to prevent race conditions
    fileParallelism: false,
    poolOptions: {
      workers: {
        // Use wrangler config to get D1 bindings
        wrangler: {
          configPath: "./wrangler.json",
        },
        miniflare: {
          // Use in-memory D1 database for test isolation
          // Each test file gets a fresh database via test-setup.ts
          d1Persist: false,
        },
        // Disable isolation to share DB across test files
        // (required because test-setup.ts module caching causes isolation issues)
        isolatedStorage: false,
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
