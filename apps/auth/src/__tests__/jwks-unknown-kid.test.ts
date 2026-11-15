/**
 * Auth#13: a token signed with a key created after the JWKS cache was filled
 * (a new or rotated signing key) verifies at once; the cache reloads for the
 * unknown kid instead of rejecting the token until the cache expires.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import {
  SignJWT,
  exportPKCS8,
  exportSPKI,
  generateKeyPair,
  jwtVerify,
  errors,
} from "jose";
import { D1AtomicStorage } from "../storage/d1-atomic";
import { setupDatabase } from "../test-setup";
import {
  SIGNING_KEY_INDEX,
  UNKNOWN_KID_REFETCH_COOLDOWN,
  clearJWKSCache,
  getJWKS,
  issuerKeySet,
} from "../utils/jwks-cache";

const ISSUER = "http://localhost:3301";
const DB = () => (env as unknown as Env).AUTH_DB;
const keyEnv = () => ({
  AUTH_STORAGE: (env as unknown as Env).AUTH_STORAGE,
  AUTH_DB: DB(),
});

async function makeKey(id: string) {
  const pair = await generateKeyPair("ES256", { extractable: true });
  const stored = {
    id,
    publicKey: await exportSPKI(pair.publicKey),
    privateKey: await exportPKCS8(pair.privateKey),
    created: Date.now(),
    alg: "ES256",
  };
  const sign = () =>
    new SignJWT({ mode: "access" })
      .setProtectedHeader({ alg: "ES256", kid: id })
      .setIssuer(ISSUER)
      .setExpirationTime("5m")
      .sign(pair.privateKey);
  return { stored, sign };
}

const verify = (token: string) =>
  jwtVerify(token, issuerKeySet(keyEnv()), { issuer: ISSUER });

describe("issuerKeySet reloads the keys for an unknown kid", () => {
  afterEach(async () => {
    vi.useRealTimers();
    clearJWKSCache();
  });

  it("verifies a token signed by a key published after the cache was filled", async () => {
    await setupDatabase();
    const store = D1AtomicStorage(DB());
    const before = (await store.get(SIGNING_KEY_INDEX)) as
      | { keys?: unknown[] }
      | undefined;
    const oldKey = await makeKey("kid-before");
    const newKey = await makeKey("kid-after");
    try {
      await store.set(SIGNING_KEY_INDEX, { keys: [oldKey.stored] });
      clearJWKSCache();
      await expect(verify(await oldKey.sign())).resolves.toBeTruthy();
      // The cache now holds kid-before only; a new key is published
      await store.set(SIGNING_KEY_INDEX, {
        keys: [oldKey.stored, newKey.stored],
      });
      expect((await getJWKS(keyEnv())).keys.map((k) => k.kid)).not.toContain(
        "kid-after",
      );
      await expect(verify(await newKey.sign())).resolves.toBeTruthy();
      // Tokens of the older key still verify during the overlap
      await expect(verify(await oldKey.sign())).resolves.toBeTruthy();
    } finally {
      await store.set(SIGNING_KEY_INDEX, before ?? { keys: [] });
    }
  });

  it("reloads at most once per cooldown for kids that do not exist", async () => {
    await setupDatabase();
    const store = D1AtomicStorage(DB());
    const before = (await store.get(SIGNING_KEY_INDEX)) as
      | { keys?: unknown[] }
      | undefined;
    const known = await makeKey("kid-known");
    await store.set(SIGNING_KEY_INDEX, { keys: [known.stored] });
    clearJWKSCache();
    vi.useFakeTimers({ toFake: ["Date"] });
    const stranger = await makeKey("kid-made-up");
    try {
      const get = vi.spyOn((env as unknown as Env).AUTH_STORAGE, "get");
      await expect(verify(await stranger.sign())).rejects.toBeInstanceOf(
        errors.JWKSNoMatchingKey,
      );
      const readsAfterFirst = get.mock.calls.length;
      expect(readsAfterFirst).toBe(2); // the fill and the one reload
      await expect(verify(await stranger.sign())).rejects.toBeInstanceOf(
        errors.JWKSNoMatchingKey,
      );
      expect(get.mock.calls.length).toBe(readsAfterFirst); // inside the cooldown: no reload
      vi.setSystemTime(Date.now() + UNKNOWN_KID_REFETCH_COOLDOWN + 1);
      await expect(verify(await stranger.sign())).rejects.toBeInstanceOf(
        errors.JWKSNoMatchingKey,
      );
      expect(get.mock.calls.length).toBe(readsAfterFirst + 1);
      get.mockRestore();
    } finally {
      await store.set(SIGNING_KEY_INDEX, before ?? { keys: [] });
    }
  });
});
