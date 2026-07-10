import type { ViteUserConfig } from "vitest/config";
import { defineConfig } from "vitest/config";

export default defineConfig(async (): Promise<ViteUserConfig> => {
  const { cloudflareTest } = await import("@cloudflare/vitest-pool-workers");

  return {
    plugins: [
      cloudflareTest({
        wrangler: {
          configPath: "./wrangler.json",
        },
      }),
    ],
    test: {
      coverage: {
        provider: "v8",
        reporter: ["text", "json", "html"],
        include: ["src/**/*.ts"],
        exclude: [
          "src/**/*.test.ts",
          "src/**/*.spec.ts",
          "src/index.ts", // Main worker entry point - integration tested
        ],
      },
    },
  };
});
