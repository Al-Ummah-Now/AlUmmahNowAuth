// Keeps the KV-backed admin session's OAuth tokens fresh.
//
// Access tokens are short-lived (~15 min) and the issuer rotates the refresh
// token on every use: the old one keeps working only for a 60 s reuse window.
// So every refresh must be written back to the KV session, otherwise the next
// request re-sends a dead refresh token and the admin is signed out.
import { logger } from "./logger.server";

/** Refresh this long before the access token expires. */
export const REFRESH_SKEW_SECONDS = 120;

/** Used when a session has no readable expiresAt (matches auth.callback). */
const DEFAULT_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
/** Cloudflare KV rejects an expirationTtl below 60 s. */
const MIN_KV_TTL_SECONDS = 60;

export interface SessionTokens {
  access: string;
  refresh?: string;
}

export interface StoredSession {
  user: { id: string; email: string; roles: string[] };
  tokens: SessionTokens;
  expiresAt: string;
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

export function sessionKey(sessionToken: string): string {
  return `session:${sessionToken}`;
}

/**
 * Logout tombstone. Deleting `session:<sid>` alone is not enough: a request
 * that read the session just before logout can put it back with refreshed
 * tokens (KV is eventually consistent, so that window can be wide). The
 * tombstone outlives any session (sessions last at most 7 days from sign-in)
 * and every read and write path treats a tombstoned session as gone.
 */
export function revokedKey(sessionToken: string): string {
  return `revoked:${sessionToken}`;
}

export const REVOKED_TTL_SECONDS = DEFAULT_SESSION_TTL_SECONDS;

export async function isSessionRevoked(kv: KVNamespace, sessionToken: string): Promise<boolean> {
  return (await kv.get(revokedKey(sessionToken))) !== null;
}

/**
 * End a session for good: tombstone it, delete it, and (best effort) revoke
 * its refresh token at the issuer. Returns once KV is updated; issuer
 * failures, including a 404 from an issuer without /token/revoke yet, are
 * logged and ignored.
 */
export async function revokeSession(opts: {
  kv: KVNamespace;
  sessionToken: string;
  issuer?: string;
  clientId?: string;
  fetch?: typeof fetch;
}): Promise<void> {
  const { kv, sessionToken } = opts;
  const session = await readSession(kv, sessionToken);
  await kv.put(revokedKey(sessionToken), "1", { expirationTtl: REVOKED_TTL_SECONDS });
  await kv.delete(sessionKey(sessionToken));

  const refresh = session?.tokens?.refresh;
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

async function readSession(kv: KVNamespace, sessionToken: string): Promise<StoredSession | null> {
  const raw = await kv.get(sessionKey(sessionToken));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredSession;
  } catch {
    return null;
  }
}

/**
 * Write `tokens` into the KV session, keeping its expiresAt and the time it
 * has left (refreshing tokens does not extend the 7-day session). Never
 * writes back a session that was logged out; returns whether it wrote.
 */
export async function persistSessionTokens(
  kv: KVNamespace,
  sessionToken: string,
  tokens: SessionTokens,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const [session, revoked] = await Promise.all([
    readSession(kv, sessionToken),
    isSessionRevoked(kv, sessionToken),
  ]);
  if (!session || revoked) {
    logger.warn("Session gone or logged out; refreshed tokens not saved", { revoked });
    return false;
  }
  const expiresAtMs = Date.parse(session.expiresAt);
  const remaining = Number.isFinite(expiresAtMs)
    ? Math.floor((expiresAtMs - nowMs) / 1000)
    : DEFAULT_SESSION_TTL_SECONDS;
  if (remaining <= 0) return false; // expired; getAuthenticatedUser deletes it next time

  const updated: StoredSession = {
    ...session,
    tokens: { access: tokens.access, refresh: tokens.refresh ?? session.tokens?.refresh },
  };
  await kv.put(sessionKey(sessionToken), JSON.stringify(updated), {
    expirationTtl: Math.max(MIN_KV_TTL_SECONDS, remaining),
  });

  // Logout may have landed between the read and the put: undo the write.
  if (await isSessionRevoked(kv, sessionToken)) {
    await kv.delete(sessionKey(sessionToken));
    logger.warn("Session logged out during token refresh; write undone");
    return false;
  }
  return true;
}

export type FreshTokensResult =
  | { ok: true; tokens: SessionTokens; source: "current" | "stored" | "refreshed" }
  | { ok: false; reason: string; revoked?: boolean };

/**
 * Tokens that are good for at least REFRESH_SKEW_SECONDS more, refreshing
 * (and persisting) them ahead of expiry when needed.
 *
 * Right before refreshing, the KV session is re-read: when a concurrent
 * request already rotated the tokens, those are used instead of spending the
 * (by now rotated) refresh token again.
 */
export async function ensureFreshTokens(opts: {
  kv: KVNamespace;
  sessionToken: string;
  tokens: SessionTokens;
  client: TokenRefresher;
  now?: () => number;
}): Promise<FreshTokensResult> {
  const now = opts.now ?? Date.now;
  const { kv, sessionToken, client } = opts;

  if (!needsRefresh(opts.tokens.access, now())) {
    return { ok: true, tokens: opts.tokens, source: "current" };
  }

  // Another request may have rotated the tokens since this one read them,
  // or the session may have been logged out.
  const [stored, revoked] = await Promise.all([
    readSession(kv, sessionToken),
    isSessionRevoked(kv, sessionToken),
  ]);
  if (revoked || !stored) {
    return { ok: false, reason: revoked ? "session logged out" : "session gone", revoked };
  }
  if (stored.tokens?.access && stored.tokens.access !== opts.tokens.access && !needsRefresh(stored.tokens.access, now())) {
    logger.debug("Using tokens already refreshed by another request");
    return { ok: true, tokens: stored.tokens, source: "stored" };
  }

  const refreshToken = stored.tokens?.refresh ?? opts.tokens.refresh;
  const currentAccess = stored.tokens?.access ?? opts.tokens.access;
  if (!refreshToken) {
    return isExpired(currentAccess, now())
      ? { ok: false, reason: "access token expired and session has no refresh token" }
      : { ok: true, tokens: { access: currentAccess }, source: "current" };
  }

  let failure: string;
  try {
    const refreshed = await client.refresh(refreshToken);
    if (!refreshed.err && refreshed.tokens) {
      const tokens = { access: refreshed.tokens.access, refresh: refreshed.tokens.refresh };
      if (!(await persistSessionTokens(kv, sessionToken, tokens, now()))) {
        return { ok: false, reason: "session logged out during refresh", revoked: true };
      }
      logger.info("Access token refreshed ahead of expiry");
      return { ok: true, tokens, source: "refreshed" };
    }
    failure = refreshed.err instanceof Error ? refreshed.err.name : "refresh returned no tokens";
  } catch (error) {
    // e.g. network error, or a non-JSON 5xx body from the issuer
    failure = error instanceof Error ? error.message : String(error);
  }

  // Refresh failed. While the current access token is still valid, keep the
  // session working; the next request tries again.
  if (!isExpired(currentAccess, now())) {
    logger.warn("Token refresh failed; current access token still valid", { failure });
    return { ok: true, tokens: { access: currentAccess, refresh: refreshToken }, source: "current" };
  }
  return { ok: false, reason: failure };
}
