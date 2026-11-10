/**
 * The profile app's session and keeping its OAuth tokens fresh (PF-1, PF-2).
 *
 * Access tokens live 15 minutes and the issuer rotates the refresh token on
 * every use; a refresh token used again more than 60 s after its rotation is
 * treated as theft and every refresh token of the user is revoked (signed out
 * of every app and device). Sessions used to live in KV, where another
 * location could still read the previous refresh token for about that long,
 * so concurrent tabs at the refresh threshold could sign the user out
 * everywhere, and logout took up to a minute to reach other locations.
 *
 * Sessions now live in D1 (`app_sessions`, auth migration 0021), which every
 * location reads current:
 * - A refresh is serialized per session: a request takes the session's
 *   refresh lock with one conditional UPDATE (only while the lock is free and
 *   the refresh token is the one it read). Other requests wait for the
 *   holder's rotated tokens instead of spending the same refresh token.
 * - Only the lock holder saves the rotated pair, and only while the session
 *   is not logged out, so a logout can never be undone by a racing refresh.
 * - Logout sets `revoked_at`; every location sees it on its next read.
 *
 * Sessions created before this change are still in KV: the first read copies
 * one into D1 (if it is not logged out or expired), and from then on D1 alone
 * decides. The row id is the SHA-256 of the cookie value.
 */

export const SESSION_COOKIE = "profile_session";
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
/** Refresh this long before the access token expires. */
export const REFRESH_SKEW_SECONDS = 120;
/** How long a refresh may hold the lock; well inside the issuer's 60 s reuse window. */
export const REFRESH_LOCK_MS = 15_000;
/** How long a request waits for another request's refresh of the same session. */
export const REFRESH_WAIT_MS = 5_000;
const REFRESH_POLL_MS = 100;

const APP = "profile";

export interface SessionTokens {
  access: string;
  refresh?: string;
}

export interface StoredSession {
  user: { id: string; email: string; roles: string[] };
  tokens: SessionTokens;
  expiresAt: string;
}

/** Where sessions live: D1, plus the KV namespace that holds sessions from before PF-1. */
export interface SessionStores {
  db: D1Database;
  kv: KVNamespace;
}

/** The subset of the openauth client used here. */
export interface TokenRefresher {
  refresh(
    refresh: string,
  ): Promise<{ err: false; tokens?: { access: string; refresh: string } } | { err: unknown; tokens?: undefined }>;
}

/** KV keys of sessions written before PF-1 (read, copied to D1, then deleted). */
export const sessionKey = (token: string) => `session:${token}`;
export const revokedKey = (token: string) => `profile-revoked:${token}`;

interface SessionRow {
  id: string;
  user_json: string;
  access_token: string;
  refresh_token: string | null;
  expires_at: number;
  revoked_at: number | null;
}

const ROW_COLUMNS = "id, user_json, access_token, refresh_token, expires_at, revoked_at";

export async function sessionId(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function readRow(db: D1Database, id: string): Promise<SessionRow | null> {
  return db.prepare(`SELECT ${ROW_COLUMNS} FROM app_sessions WHERE id = ?1 AND app = ?2`).bind(id, APP).first<SessionRow>();
}

function rowToSession(row: SessionRow): StoredSession {
  return {
    user: JSON.parse(row.user_json) as StoredSession["user"],
    tokens: row.refresh_token ? { access: row.access_token, refresh: row.refresh_token } : { access: row.access_token },
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}

function insertRow(db: D1Database, id: string, session: StoredSession, nowMs: number, ifAbsent: boolean) {
  return db
    .prepare(
      `INSERT INTO app_sessions (id, app, user_json, access_token, refresh_token, expires_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)${ifAbsent ? " ON CONFLICT(id) DO NOTHING" : ""}`,
    )
    .bind(
      id,
      APP,
      JSON.stringify(session.user),
      session.tokens.access,
      session.tokens.refresh ?? null,
      Date.parse(session.expiresAt),
      nowMs,
    )
    .run();
}

/** A session from before PF-1, still in KV: copied into D1 unless logged out, corrupt or expired. */
async function adoptKvSession(stores: SessionStores, token: string, id: string, nowMs: number): Promise<SessionRow | null> {
  const [raw, revoked] = await Promise.all([stores.kv.get(sessionKey(token)), stores.kv.get(revokedKey(token))]);
  if (!raw || revoked !== null) return null;
  let session: StoredSession;
  try {
    session = JSON.parse(raw) as StoredSession;
  } catch {
    return null;
  }
  if (!session?.user || !session.tokens?.access) return null;
  const expiresAt = Date.parse(session.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) return null;
  // DO NOTHING: a concurrent first read (or a logout) already decided
  await insertRow(stores.db, id, session, nowMs, true);
  return readRow(stores.db, id);
}

const REVOKE_SQL = `UPDATE app_sessions SET revoked_at = ?2, access_token = '', refresh_token = NULL, refresh_lock = NULL, refresh_lock_until = 0, updated_at = ?2
       WHERE id = ?1 AND revoked_at IS NULL`;

async function loadRow(stores: SessionStores, token: string, nowMs: number): Promise<SessionRow | null> {
  const id = await sessionId(token);
  const row = (await readRow(stores.db, id)) ?? (await adoptKvSession(stores, token, id, nowMs));
  if (!row || row.revoked_at !== null) return row;
  // A logout through KV (the previous version, or a location whose KV had not
  // yet shown the tombstone when the session was copied) still counts: KV
  // tombstones live as long as the sessions they end
  if ((await stores.kv.get(revokedKey(token))) !== null) {
    await stores.db.prepare(REVOKE_SQL).bind(id, nowMs).run();
    return { ...row, revoked_at: nowMs, access_token: "", refresh_token: null };
  }
  return row;
}

/** The live session for `token`, or null (missing, expired or logged out). */
export async function getSession(stores: SessionStores, token: string | null, nowMs = Date.now()): Promise<StoredSession | null> {
  if (!token) return null;
  try {
    const row = await loadRow(stores, token, nowMs);
    if (!row || row.revoked_at !== null || row.expires_at <= nowMs) return null;
    return rowToSession(row);
  } catch (error) {
    console.error("Error retrieving session:", error);
    return null;
  }
}

export async function createSession(
  stores: SessionStores,
  data: { user: StoredSession["user"]; tokens: SessionTokens },
  nowMs = Date.now(),
): Promise<string> {
  const token = crypto.randomUUID();
  const session: StoredSession = { ...data, expiresAt: new Date(nowMs + SESSION_TTL_SECONDS * 1000).toISOString() };
  await insertRow(stores.db, await sessionId(token), session, nowMs, false);
  return token;
}

/**
 * Ends a session for good, in every location at once. A token with no session
 * behind it writes nothing (a made-up cookie must not cost writes).
 */
export async function endSession(stores: SessionStores, token: string, nowMs = Date.now()): Promise<void> {
  const row = await loadRow(stores, token, nowMs);
  if (!row) return;
  await stores.db.prepare(REVOKE_SQL).bind(row.id, nowMs).run();
  // A session from before this change: tombstone its KV copy too, so instances
  // of the previous version (during a rollout) also treat it as logged out
  if ((await stores.kv.get(sessionKey(token))) !== null) {
    await stores.kv.put(revokedKey(token), "1", { expirationTtl: SESSION_TTL_SECONDS });
    await stores.kv.delete(sessionKey(token));
  }
}

/** `exp` (seconds) of a JWT, unverified; null if unreadable. */
export function decodeJwtExp(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const exp = (JSON.parse(atob(padded)) as { exp?: unknown } | null)?.exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp : null;
  } catch {
    return null;
  }
}

/** Whether the access token expires within `skewSeconds` (unreadable tokens count as expired). */
export function needsRefresh(access: string, nowMs = Date.now(), skewSeconds = REFRESH_SKEW_SECONDS): boolean {
  const exp = decodeJwtExp(access);
  if (exp === null) return true;
  return exp - nowMs / 1000 <= skewSeconds;
}

export type FreshResult =
  | { ok: true; tokens: SessionTokens; refreshed: boolean }
  | { ok: false; reason: string };

const tokensOf = (row: SessionRow): SessionTokens =>
  row.refresh_token ? { access: row.access_token, refresh: row.refresh_token } : { access: row.access_token };

/**
 * Tokens good for at least REFRESH_SKEW_SECONDS more, refreshing (and saving)
 * them ahead of expiry, at most one refresh per session at a time. While a
 * failed refresh still leaves a valid access token, the session keeps working
 * and the next request tries again; once the access token has expired and
 * refresh fails, the caller re-authorizes silently (prompt=none).
 */
export async function ensureFreshTokens(o: {
  stores: SessionStores;
  token: string;
  tokens: SessionTokens;
  client: TokenRefresher;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<FreshResult> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  if (!needsRefresh(o.tokens.access, now())) return { ok: true, tokens: o.tokens, refreshed: false };

  const db = o.stores.db;
  const id = await sessionId(o.token);
  const deadline = now() + REFRESH_WAIT_MS;
  for (;;) {
    const row = await readRow(db, id);
    if (!row || row.revoked_at !== null) return { ok: false, reason: row ? "logged out" : "session gone" };
    // Another request may already have rotated the tokens
    if (!needsRefresh(row.access_token, now())) return { ok: true, tokens: tokensOf(row), refreshed: false };
    const stillValid = !needsRefresh(row.access_token, now(), 0);
    if (!row.refresh_token) {
      return stillValid ? { ok: true, tokens: tokensOf(row), refreshed: false } : { ok: false, reason: "no refresh token" };
    }

    const lock = crypto.randomUUID();
    const held = await db
      .prepare(
        `UPDATE app_sessions SET refresh_lock = ?2, refresh_lock_until = ?3
         WHERE id = ?1 AND revoked_at IS NULL AND refresh_token = ?4 AND refresh_lock_until <= ?5
         RETURNING id`,
      )
      .bind(id, lock, now() + REFRESH_LOCK_MS, row.refresh_token, now())
      .first();
    if (held) return refreshHoldingLock(db, row, lock, o.client, now, stillValid);

    // Someone else is refreshing this session: wait for their tokens
    if (now() >= deadline) {
      return stillValid
        ? { ok: true, tokens: tokensOf(row), refreshed: false }
        : { ok: false, reason: "another refresh of this session did not finish" };
    }
    await sleep(REFRESH_POLL_MS);
  }
}

async function refreshHoldingLock(
  db: D1Database,
  row: SessionRow,
  lock: string,
  client: TokenRefresher,
  now: () => number,
  stillValid: boolean,
): Promise<FreshResult> {
  let failure: string;
  try {
    const result = await client.refresh(row.refresh_token!);
    if (!result.err && result.tokens) {
      const tokens = { access: result.tokens.access, refresh: result.tokens.refresh };
      const saved = await db
        .prepare(
          `UPDATE app_sessions SET access_token = ?3, refresh_token = ?4, refresh_lock = NULL, refresh_lock_until = 0, updated_at = ?5
           WHERE id = ?1 AND refresh_lock = ?2 AND revoked_at IS NULL
           RETURNING id`,
        )
        .bind(row.id, lock, tokens.access, tokens.refresh, now())
        .first();
      if (saved) return { ok: true, tokens, refreshed: true };
      const current = await readRow(db, row.id);
      if (!current || current.revoked_at !== null) return { ok: false, reason: "logged out during refresh" };
      // The lock ran out and another request took over; it gets the same rotated pair
      return { ok: true, tokens, refreshed: true };
    }
    failure = result.err instanceof Error ? result.err.name : "refresh returned no tokens";
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  await db
    .prepare(`UPDATE app_sessions SET refresh_lock = NULL, refresh_lock_until = 0 WHERE id = ?1 AND refresh_lock = ?2`)
    .bind(row.id, lock)
    .run();
  if (stillValid) {
    console.warn("Token refresh failed; current access token still valid", failure);
    return { ok: true, tokens: tokensOf(row), refreshed: false };
  }
  return { ok: false, reason: failure };
}
