// Shared fixtures for the session/token unit tests (not shipped: only *.test.ts import it).
import type { StoredSession } from "./session-tokens.server";

export const NOW_MS = 1_800_000_000_000;
export const NOW_S = NOW_MS / 1000;

function b64url(value: unknown): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** An unsigned JWT-shaped token with the given exp (seconds). */
export function jwt(exp: number, tag = "t"): string {
  return `${b64url({ alg: "ES256", typ: "JWT" })}.${b64url({ mode: "access", exp, tag })}.sig`;
}

/** In-memory KVNamespace with the calls the session code makes. */
export class FakeKV {
  store = new Map<string, string>();
  puts: Array<{ key: string; value: string; expirationTtl?: number }> = [];

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
    this.puts.push({ key, value, expirationTtl: opts?.expirationTtl });
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
  asKV(): KVNamespace {
    return this as unknown as KVNamespace;
  }
  session(token: string): StoredSession {
    return JSON.parse(this.store.get(`session:${token}`)!) as StoredSession;
  }
}

export function storedSession(access: string, refresh: string, expiresInMs = 3 * 24 * 3600 * 1000): StoredSession {
  return {
    user: { id: "u1", email: "admin@example.com", roles: ["Admin"] },
    tokens: { access, refresh },
    expiresAt: new Date(NOW_MS + expiresInMs).toISOString(),
  };
}
