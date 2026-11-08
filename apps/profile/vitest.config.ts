import { defineConfig } from "vitest/config";

// The profile worker's testable logic (app catalog, i18n, launcher markup) is
// pure TypeScript, so unit tests run in plain Node rather than the Workers pool.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/index.ts", // Main worker entry point - integration tested
      ],
    },
  },
});
