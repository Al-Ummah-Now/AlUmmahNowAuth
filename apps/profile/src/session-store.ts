/**
 * The profile app's KV session and keeping its OAuth tokens fresh.
 *
 * Access tokens live 15 minutes and the issuer rotates the refresh token on
 * every use (the old one only works for a short reuse window), so tokens are
 * refreshed ahead of expiry and the rotated pair is written back to the
 * session. Logout leaves a tombstone so a request that read the session just
 * before logout cannot write it back with refreshed tokens. Same approach as
 * the auth admin (apps/admin/app/lib/session-tokens.server.ts).
 */

export const SESSION_COOKIE = "profile_session";
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
/** Refresh this long before the access token expires. */
export const REFRESH_SKEW_SECONDS = 120;
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

/** The subset of the openauth client used here. */
export interface TokenRefresher {
  refresh(
    refresh: string,
  ): Promise<{ err: false; tokens?: { access: string; refresh: string } } | { err: unknown; tokens?: undefined }>;
}

export const sessionKey = (token: string) => `session:${token}`;
export const revokedKey = (token: string) => `profile-revoked:${token}`;

export async function isSessionRevoked(kv: KVNamespace, token: string): Promise<boolean> {
  return (await kv.get(revokedKey(token))) !== null;
}

async function readSession(kv: KVNamespace, token: string): Promise<StoredSession | null> {
  const raw = await kv.get(sessionKey(token));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredSession;
  } catch {
    return null;
  }
}

/** The live session for `token`, or null (missing, corrupt, expired or logged out). */
export async function getSession(kv: KVNamespace, token: string | null, nowMs = Date.now()): Promise<StoredSession | null> {
  if (!token) return null;
  try {
    const [raw, revoked] = await Promise.all([kv.get(sessionKey(token)), isSessionRevoked(kv, token)]);
    if (!raw) return null;
    if (revoked) {
      await kv.delete(sessionKey(token));
      return null;
    }
    let session: StoredSession;
    try {
      session = JSON.parse(raw) as StoredSession;
    } catch {
      console.error("Failed to parse session data, deleting corrupted session");
      await kv.delete(sessionKey(token));
      return null;
    }
    if (session.expiresAt && Date.parse(session.expiresAt) < nowMs) {
      await kv.delete(sessionKey(token));
      return null;
    }
    return session;
  } catch (error) {
    console.error("Error retrieving session:", error);
    return null;
  }
}

export async function createSession(
  kv: KVNamespace,
  data: { user: StoredSession["user"]; tokens: SessionTokens },
  nowMs = Date.now(),
): Promise<string> {
  const token = crypto.randomUUID();
  const session: StoredSession = { ...data, expiresAt: new Date(nowMs + SESSION_TTL_SECONDS * 1000).toISOString() };
  await kv.put(sessionKey(token), JSON.stringify(session), { expirationTtl: SESSION_TTL_SECONDS });
  return token;
}

/**
 * Ends a session for good: tombstone first, then delete. A token with no
 * session behind it writes nothing (a made-up cookie must not cost KV writes;
 * with no session to read, a racing refresh has nothing to write back either).
 */
export async function endSession(kv: KVNamespace, token: string): Promise<void> {
  if ((await kv.get(sessionKey(token))) === null) return;
  await kv.put(revokedKey(token), "1", { expirationTtl: SESSION_TTL_SECONDS });
  await kv.delete(sessionKey(token));
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

/** Writes rotated tokens into the session, keeping its expiry; never revives a logged-out session. */
export async function persistSessionTokens(
  kv: KVNamespace,
  token: string,
  tokens: SessionTokens,
  nowMs = Date.now(),
): Promise<boolean> {
  const [session, revoked] = await Promise.all([readSession(kv, token), isSessionRevoked(kv, token)]);
  if (!session || revoked) return false;
  const expiresAtMs = Date.parse(session.expiresAt);
  const remaining = Number.isFinite(expiresAtMs) ? Math.floor((expiresAtMs - nowMs) / 1000) : SESSION_TTL_SECONDS;
  if (remaining <= 0) return false;
  const updated: StoredSession = {
    ...session,
    tokens: { access: tokens.access, refresh: tokens.refresh ?? session.tokens?.refresh },
  };
  await kv.put(sessionKey(token), JSON.stringify(updated), { expirationTtl: Math.max(MIN_KV_TTL_SECONDS, remaining) });
  if (await isSessionRevoked(kv, token)) {
    await kv.delete(sessionKey(token));
    return false;
  }
  return true;
}

export type FreshResult =
  | { ok: true; tokens: SessionTokens; refreshed: boolean }
  | { ok: false; reason: string };

/**
 * Tokens good for at least REFRESH_SKEW_SECONDS more, refreshing (and saving)
 * them ahead of expiry. While a failed refresh still leaves a valid access
 * token, the session keeps working and the next request tries again; once
 * the access token has expired and refresh fails, the caller re-authorizes
 * silently (prompt=none).
 */
export async function ensureFreshTokens(o: {
  kv: KVNamespace;
  token: string;
  tokens: SessionTokens;
  client: TokenRefresher;
  now?: () => number;
}): Promise<FreshResult> {
  const now = o.now ?? Date.now;
  if (!needsRefresh(o.tokens.access, now())) return { ok: true, tokens: o.tokens, refreshed: false };

  // A concurrent request may already have rotated the tokens, or logout landed.
  const [stored, revoked] = await Promise.all([readSession(o.kv, o.token), isSessionRevoked(o.kv, o.token)]);
  if (revoked || !stored) return { ok: false, reason: revoked ? "logged out" : "session gone" };
  if (stored.tokens?.access && stored.tokens.access !== o.tokens.access && !needsRefresh(stored.tokens.access, now())) {
    return { ok: true, tokens: stored.tokens, refreshed: false };
  }

  const refreshToken = stored.tokens?.refresh ?? o.tokens.refresh;
  const currentAccess = stored.tokens?.access ?? o.tokens.access;
  const stillValid = !needsRefresh(currentAccess, now(), 0);
  if (!refreshToken) {
    return stillValid ? { ok: true, tokens: { access: currentAccess }, refreshed: false } : { ok: false, reason: "no refresh token" };
  }

  let failure: string;
  try {
    const result = await o.client.refresh(refreshToken);
    if (!result.err && result.tokens) {
      const tokens = { access: result.tokens.access, refresh: result.tokens.refresh };
      if (!(await persistSessionTokens(o.kv, o.token, tokens, now()))) return { ok: false, reason: "logged out during refresh" };
      return { ok: true, tokens, refreshed: true };
    }
    failure = result.err instanceof Error ? result.err.name : "refresh returned no tokens";
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  if (stillValid) {
    console.warn("Token refresh failed; current access token still valid", failure);
    return { ok: true, tokens: { access: currentAccess, refresh: refreshToken }, refreshed: false };
  }
  return { ok: false, reason: failure };
}
