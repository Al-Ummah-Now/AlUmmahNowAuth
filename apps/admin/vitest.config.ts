import { defineConfig } from "vitest/config";

// The admin app's unit-tested logic (session/token handling) is plain
// TypeScript over a KV interface, so tests run in Node with an in-memory KV
// rather than the Workers pool (which also needs a wrangler.toml this app
// does not have).
export default defineConfig({
  test: {
    include: ["app/**/*.test.ts"],
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
