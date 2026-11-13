import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  // @simplewebauthn/server (passkeys, via @al-ummah-now/openauth) pulls in tslib,
  // whose ESM entry re-exports its CJS file, which workerd can't load unbundled:
  // resolve "tslib" to its own ESM build, from each importer
  plugins: [
    {
      name: "tslib-esm",
      enforce: "pre",
      async resolveId(id, importer) {
        if (id !== "tslib") return null;
        return this.resolve("tslib/tslib.es6.mjs", importer, { skipSelf: true });
      },
    },
  ],
  test: {
    // Through Vite (so the plugin above applies), not workerd's module fallback
    server: { deps: { inline: [/@simplewebauthn/, /@peculiar/, /tsyringe/, /asn1js/, /pvtsutils/, /@levischuck/, /@hexagon/] } },
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
          // Many tests sign the same users in from one address; the real limits
          // (wrangler.json) would turn them into 429s. password-bruteforce.test.ts and
          // rate-limit-bindings.test.ts test the limiter behaviour with their own bindings.
          ratelimits: {
            PASSWORD_IP_LIMITER: { simple: { limit: 1_000_000, period: 60 } },
            PASSWORD_EMAIL_LIMITER: { simple: { limit: 1_000_000, period: 60 } },
            TOKEN_LIMITER: { simple: { limit: 1_000_000, period: 60 } },
            TOKEN_CLIENT_LIMITER: { simple: { limit: 1_000_000, period: 60 } },
            SEND_CODE_LIMITER: { simple: { limit: 1_000_000, period: 60 } },
            ADMIN_LIMITER: { simple: { limit: 1_000_000, period: 60 } },
            ADMIN_SENSITIVE_LIMITER: { simple: { limit: 1_000_000, period: 60 } },
            // Test-only: a real (miniflare) limiter with a small limit
            TEST_LIMITER: { simple: { limit: 10, period: 60 } },
          },
        },
        // Disable isolation to share DB across test files
        // (required because test-setup.ts module caching causes isolation issues)
        isolatedStorage: false,
        // Force all tests into a single worker to share D1 database state
        // This ensures setupDatabase() creates tables once and they persist
        singleWorker: true,
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
