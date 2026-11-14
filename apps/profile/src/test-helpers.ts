// Shared fixtures for unit tests (not shipped: only *.test.ts import it).
import type { StoredSession } from "./session-store";

export const NOW_MS = 1_800_000_000_000;
export const NOW_S = NOW_MS / 1000;

function b64url(value: unknown): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** An unsigned JWT-shaped token with the given exp (seconds). */
export function jwt(exp: number, tag = "t", iat?: number): string {
  return `${b64url({ alg: "ES256", typ: "JWT" })}.${b64url({ mode: "access", exp, tag, ...(iat === undefined ? {} : { iat }) })}.sig`;
}

/** In-memory KVNamespace with the calls the session code makes. */
export class FakeKV {
  store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
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

/**
 * D1 on SQLite (node:sqlite) with the real auth migration for app_sessions, so
 * the session SQL (conditional UPDATE ... RETURNING, ON CONFLICT) runs on real
 * SQLite semantics. Every statement is atomic, like D1's single writer, and
 * each call yields to the event loop first, so concurrent requests interleave.
 */
export async function fakeD1(): Promise<D1Database & { rows(): Record<string, unknown>[] }> {
  const { DatabaseSync } = await import("node:sqlite");
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(fileURLToPath(new URL("../../auth/migrations/0025_app_sessions.sql", import.meta.url).href), "utf8"));
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));
  const statement = (sql: string, params: unknown[] = []) => ({
    bind: (...values: unknown[]) => statement(sql, values),
    async first<T>() {
      await tick();
      return (db.prepare(sql).get(...(params as never[])) as T | undefined) ?? null;
    },
    async all<T>() {
      await tick();
      return { results: db.prepare(sql).all(...(params as never[])) as T[], success: true };
    },
    async run() {
      await tick();
      const r = db.prepare(sql).run(...(params as never[]));
      return { success: true, meta: { changes: Number(r.changes) } };
    },
  });
  return {
    prepare: (sql: string) => statement(sql),
    rows: () => db.prepare("SELECT * FROM app_sessions").all() as Record<string, unknown>[],
  } as unknown as D1Database & { rows(): Record<string, unknown>[] };
}
