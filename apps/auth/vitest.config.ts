import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
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
        // namespace_id: the same ids as wrangler.json (miniflare requires one).
        ratelimits: {
          PASSWORD_IP_LIMITER: { namespace_id: "3001", simple: { limit: 1_000_000, period: 60 } },
          PASSWORD_EMAIL_LIMITER: { namespace_id: "3002", simple: { limit: 1_000_000, period: 60 } },
          TOKEN_LIMITER: { namespace_id: "3003", simple: { limit: 1_000_000, period: 60 } },
          TOKEN_CLIENT_LIMITER: { namespace_id: "3004", simple: { limit: 1_000_000, period: 60 } },
          SEND_CODE_LIMITER: { namespace_id: "3005", simple: { limit: 1_000_000, period: 60 } },
          ADMIN_LIMITER: { namespace_id: "3006", simple: { limit: 1_000_000, period: 60 } },
          ADMIN_SENSITIVE_LIMITER: { namespace_id: "3007", simple: { limit: 1_000_000, period: 60 } },
          NATIVE_PASSKEY_LIMITER: { namespace_id: "3008", simple: { limit: 1_000_000, period: 60 } },
          BIRTH_DATE_LIMITER: { namespace_id: "3009", simple: { limit: 1_000_000, period: 60 } },
          ACCOUNT_DELETION_LIMITER: { namespace_id: "3010", simple: { limit: 1_000_000, period: 60 } },
          // Test-only: a real (miniflare) limiter with a small limit
          TEST_LIMITER: { namespace_id: "3999", simple: { limit: 10, period: 60 } },
        },
      },
    }),
    // @simplewebauthn/server (passkeys, via @al-ummah-now/openauth) pulls in tslib,
    // whose ESM entry re-exports its CJS file, which workerd can't load unbundled:
    // resolve "tslib" to its own ESM build, from each importer
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
    // One worker, no isolation, files in sequence: every test file shares one
    // D1/KV (setupDatabase() creates the tables once; test-setup.ts module
    // caching assumes it). This replaces the pool's removed
    // `singleWorker: true` + `isolatedStorage: false`.
    maxWorkers: 1,
    isolate: true,
    fileParallelism: false,
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
