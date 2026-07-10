import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
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
      include: ["app/**/*.ts", "app/**/*.tsx"],
      exclude: [
        "app/**/*.test.ts",
        "app/**/*.test.tsx",
        "app/**/*.spec.ts",
        "app/**/*.spec.tsx",
      ],
    },
  },
});
