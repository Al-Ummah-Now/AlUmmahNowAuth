import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        // Use wrangler config to get D1 bindings with local persistence
        wrangler: {
          configPath: "./wrangler.json",
        },
        miniflare: {
          // Use local D1 database (apply migrations first with: pnpm migrations:local)
          d1Persist: ".wrangler/state/v3/d1",
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
