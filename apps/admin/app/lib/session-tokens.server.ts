// The admin session and keeping its OAuth tokens fresh (AD-1).
//
// Access tokens are short-lived (~15 min) and the issuer rotates the refresh
// token on every use; a refresh token used again more than 60 s after its
// rotation counts as theft and every refresh token of the user is revoked.
// Sessions used to live in KV, where another location could still read the
// previous refresh token for about that long, so concurrent requests at the
// refresh threshold could sign the admin out of everything.
//
// Sessions now live in the auth D1 (`app_sessions`, auth migration 0021),
// read current in every location. A refresh is serialized per session: a
// request takes the session's refresh lock with one conditional UPDATE, and
// other requests wait for the holder's rotated tokens instead of spending the
// same refresh token. Only the lock holder saves, and only while the session
// is not logged out. Logout sets `revoked_at`, seen everywhere at once.
// Sessions created before this change are copied from KV into D1 on first
// read; from then on D1 alone decides. Same design as apps/profile.
import { logger } from "./logger.server";

/** Refresh this long before the access token expires. */
export const REFRESH_SKEW_SECONDS = 120;
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
/** How long a refresh may hold the lock; well inside the issuer's 60 s reuse window. */
export const REFRESH_LOCK_MS = 15_000;
/** How long a request waits for another request's refresh of the same session. */
export const REFRESH_WAIT_MS = 5_000;
const REFRESH_POLL_MS = 100;

const APP = "admin";

export interface SessionTokens {
  access: string;
  refresh?: string;
}

export interface StoredSession {
  user: { id: string; email: string; roles: string[] };
  tokens: SessionTokens;
  expiresAt: string;
}

/** Where sessions live: the auth D1, plus the KV namespace holding sessions from before AD-1. */
export interface SessionStores {
  db: D1Database;
  kv: KVNamespace;
}

/** The subset of the openauth client used here (keeps tests simple). */
export interface TokenRefresher {
  refresh(
    refresh: string,
  ): Promise<
    | { err: false; tokens?: { access: string; refresh: string } }
    | { err: unknown; tokens?: undefined }
  >;
}

/** KV keys of sessions written before AD-1 (read, copied to D1, then deleted). */
export function sessionKey(sessionToken: string): string {
  return `session:${sessionToken}`;
}
export function revokedKey(sessionToken: string): string {
  return `revoked:${sessionToken}`;
}

interface SessionRow {
  id: string;
  user_json: string;
  access_token: string;
  refresh_token: string | null;
  expires_at: number;
  revoked_at: number | null;
}

const ROW_COLUMNS = "id, user_json, access_token, refresh_token, expires_at, revoked_at";

export async function sessionId(sessionToken: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sessionToken));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function readRow(db: D1Database, id: string): Promise<SessionRow | null> {
  return db.prepare(`SELECT ${ROW_COLUMNS} FROM app_sessions WHERE id = ?1 AND app = ?2`).bind(id, APP).first<SessionRow>();
}

const tokensOf = (row: SessionRow): SessionTokens =>
  row.refresh_token ? { access: row.access_token, refresh: row.refresh_token } : { access: row.access_token };

function insertRow(db: D1Database, id: string, session: StoredSession, nowMs: number, ifAbsent: boolean) {
  return db
    .prepare(
      `INSERT INTO app_sessions (id, app, user_json, access_token, refresh_token, expires_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)${ifAbsent ? " ON CONFLICT(id) DO NOTHING" : ""}`,
    )
    .bind(id, APP, JSON.stringify(session.user), session.tokens.access, session.tokens.refresh ?? null, Date.parse(session.expiresAt), nowMs)
    .run();
}

/** A session from before AD-1, still in KV: copied into D1 unless logged out, corrupt or expired. */
async function adoptKvSession(stores: SessionStores, sessionToken: string, id: string, nowMs: number): Promise<SessionRow | null> {
  const [raw, revoked] = await Promise.all([stores.kv.get(sessionKey(sessionToken)), stores.kv.get(revokedKey(sessionToken))]);
  if (!raw || revoked !== null) return null;
  let session: StoredSession;
  try {
    session = JSON.parse(raw) as StoredSession;
  } catch {
    logger.warn("Corrupt KV session ignored");
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

async function loadRow(stores: SessionStores, sessionToken: string, nowMs: number): Promise<SessionRow | null> {
  const id = await sessionId(sessionToken);
  const row = (await readRow(stores.db, id)) ?? (await adoptKvSession(stores, sessionToken, id, nowMs));
  if (!row || row.revoked_at !== null) return row;
  // A logout through KV (the previous version, or a location whose KV had not
  // yet shown the tombstone when the session was copied) still counts: KV
  // tombstones live as long as the sessions they end
  if ((await stores.kv.get(revokedKey(sessionToken))) !== null) {
    await stores.db.prepare(REVOKE_SQL).bind(id, nowMs).run();
    return { ...row, revoked_at: nowMs, access_token: "", refresh_token: null };
  }
  return row;
}

/** The live session for the cookie value, or null (missing, expired or logged out). */
export async function getSession(stores: SessionStores, sessionToken: string, nowMs: number = Date.now()): Promise<StoredSession | null> {
  const row = await loadRow(stores, sessionToken, nowMs);
  if (!row || row.revoked_at !== null || row.expires_at <= nowMs) return null;
  return {
    user: JSON.parse(row.user_json) as StoredSession["user"],
    tokens: tokensOf(row),
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}

/** Starts a 7-day session; returns the cookie value. */
export async function createSession(
  stores: SessionStores,
  data: { user: StoredSession["user"]; tokens: SessionTokens },
  nowMs: number = Date.now(),
): Promise<string> {
  const sessionToken = crypto.randomUUID();
  const session: StoredSession = { ...data, expiresAt: new Date(nowMs + SESSION_TTL_SECONDS * 1000).toISOString() };
  await insertRow(stores.db, await sessionId(sessionToken), session, nowMs, false);
  return sessionToken;
}

/**
 * End a session for good, in every location at once, and (best effort) revoke
 * its refresh token at the issuer. Issuer failures, including a 404 from an
 * issuer without /token/revoke, are logged and ignored. A cookie with no
 * session behind it writes nothing.
 */
export async function revokeSession(opts: {
  stores: SessionStores;
  sessionToken: string;
  issuer?: string;
  clientId?: string;
  fetch?: typeof fetch;
  nowMs?: number;
}): Promise<void> {
  const { stores, sessionToken } = opts;
  const nowMs = opts.nowMs ?? Date.now();
  const row = await loadRow(stores, sessionToken, nowMs);
  if (!row) return;
  await stores.db.prepare(REVOKE_SQL).bind(row.id, nowMs).run();
  // A session from before this change: tombstone its KV copy too, so instances
  // of the previous version (during a rollout) also treat it as logged out
  if ((await stores.kv.get(sessionKey(sessionToken))) !== null) {
    await stores.kv.put(revokedKey(sessionToken), "1", { expirationTtl: SESSION_TTL_SECONDS });
    await stores.kv.delete(sessionKey(sessionToken));
  }

  const refresh = row.revoked_at === null ? row.refresh_token : null;
  if (!refresh || !opts.issuer || !opts.clientId) return;
  try {
    const response = await (opts.fetch ?? fetch)(new URL("/token/revoke", opts.issuer).toString(), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refresh, client_id: opts.clientId }).toString(),
    });
    if (!response.ok && response.status !== 404) {
      logger.warn("Refresh token revocation failed", { status: response.status });
    }
  } catch (error) {
    logger.warn("Refresh token revocation failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** `exp` (seconds since epoch) of a JWT, without verifying it; null if unreadable. */
export function decodeJwtExp(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const payload: unknown = JSON.parse(atob(padded));
    const exp = (payload as { exp?: unknown } | null)?.exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp : null;
  } catch {
    return null;
  }
}

/**
 * Whether the access token expires within `skewSeconds` (or already has).
 * An unreadable token is left to signature verification, which rejects it.
 */
export function needsRefresh(
  accessToken: string,
  nowMs: number = Date.now(),
  skewSeconds: number = REFRESH_SKEW_SECONDS,
): boolean {
  const exp = decodeJwtExp(accessToken);
  if (exp === null) return false;
  return exp - nowMs / 1000 <= skewSeconds;
}

function isExpired(accessToken: string, nowMs: number): boolean {
  return needsRefresh(accessToken, nowMs, 0);
}

export type FreshTokensResult =
  | { ok: true; tokens: SessionTokens; source: "current" | "stored" | "refreshed" }
  | { ok: false; reason: string; revoked?: boolean };

/**
 * Tokens that are good for at least REFRESH_SKEW_SECONDS more, refreshing (and
 * saving) them ahead of expiry, at most one refresh per session at a time.
 */
export async function ensureFreshTokens(opts: {
  stores: SessionStores;
  sessionToken: string;
  tokens: SessionTokens;
  client: TokenRefresher;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<FreshTokensResult> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  if (!needsRefresh(opts.tokens.access, now())) {
    return { ok: true, tokens: opts.tokens, source: "current" };
  }

  const db = opts.stores.db;
  const id = await sessionId(opts.sessionToken);
  const deadline = now() + REFRESH_WAIT_MS;
  for (;;) {
    const row = await readRow(db, id);
    if (!row || row.revoked_at !== null) {
      return { ok: false, reason: row ? "session logged out" : "session gone", revoked: !!row };
    }
    if (row.access_token !== opts.tokens.access && !needsRefresh(row.access_token, now())) {
      logger.debug("Using tokens already refreshed by another request");
      return { ok: true, tokens: tokensOf(row), source: "stored" };
    }
    if (!needsRefresh(row.access_token, now())) return { ok: true, tokens: tokensOf(row), source: "current" };
    if (!row.refresh_token) {
      return isExpired(row.access_token, now())
        ? { ok: false, reason: "access token expired and session has no refresh token" }
        : { ok: true, tokens: tokensOf(row), source: "current" };
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
    if (held) return refreshHoldingLock(db, row, lock, opts.client, now);

    // Another request is refreshing this session: wait for its tokens
    if (now() >= deadline) {
      return isExpired(row.access_token, now())
        ? { ok: false, reason: "another refresh of this session did not finish" }
        : { ok: true, tokens: tokensOf(row), source: "current" };
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
): Promise<FreshTokensResult> {
  let failure: string;
  try {
    const refreshed = await client.refresh(row.refresh_token!);
    if (!refreshed.err && refreshed.tokens) {
      const tokens = { access: refreshed.tokens.access, refresh: refreshed.tokens.refresh };
      const saved = await db
        .prepare(
          `UPDATE app_sessions SET access_token = ?3, refresh_token = ?4, refresh_lock = NULL, refresh_lock_until = 0, updated_at = ?5
           WHERE id = ?1 AND refresh_lock = ?2 AND revoked_at IS NULL
           RETURNING id`,
        )
        .bind(row.id, lock, tokens.access, tokens.refresh, now())
        .first();
      if (!saved) {
        const current = await readRow(db, row.id);
        if (!current || current.revoked_at !== null) {
          logger.warn("Session logged out during token refresh; tokens not saved");
          return { ok: false, reason: "session logged out during refresh", revoked: true };
        }
        // The lock ran out and another request took over; it gets the same rotated pair
      }
      logger.info("Access token refreshed ahead of expiry");
      return { ok: true, tokens, source: "refreshed" };
    }
    failure = refreshed.err instanceof Error ? refreshed.err.name : "refresh returned no tokens";
  } catch (error) {
    // e.g. network error, or a non-JSON 5xx body from the issuer
    failure = error instanceof Error ? error.message : String(error);
  }
  await db
    .prepare(`UPDATE app_sessions SET refresh_lock = NULL, refresh_lock_until = 0 WHERE id = ?1 AND refresh_lock = ?2`)
    .bind(row.id, lock)
    .run();
  // While the current access token is still valid, keep the session working; the next request tries again.
  if (!isExpired(row.access_token, now())) {
    logger.warn("Token refresh failed; current access token still valid", { failure });
    return { ok: true, tokens: tokensOf(row), source: "current" };
  }
  return { ok: false, reason: failure };
}
