import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: "./wrangler.json",
      },
      miniflare: {
        // Use in-memory D1 database for test isolation
        // Each test file gets a fresh database via test-setup.ts
        d1Persist: false,
      },
    }),
  ],
  test: {
    // Run test files sequentially to prevent race conditions
    fileParallelism: false,
    poolOptions: {
      workers: {
        // Disable isolation to share DB across test files
        // (required because test-setup.ts module caching causes isolation issues)
        isolatedStorage: false,
        // Force all tests into a single worker to share D1 database state
        // This ensures setupDatabase() creates tables once and they persist
        singleWorker: true,
      },
    },
    server: {
      deps: {
        inline: ["svix"],
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
