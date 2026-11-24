/**
 * Self-service account deletion orchestration for the profile web app (AlUmmahNowAuth#532).
 *
 * Reuses the existing erase endpoints without introducing a second erase backend:
 *   1. Verify the request targets the exact signed-in user (both `session.user.id` and
 *      the token's `properties.id`) so a tab opened under account A can never delete
 *      account B after a session switch in another tab.
 *   2. Verify the access token's `auth_time` is within PRECHECK_REAUTH_MAX_AGE_SECONDS
 *      (300s — leaving a 5-minute safety margin inside Auth's 600s limit) BEFORE touching
 *      any user content, so a stale session triggers step-up sign-in first.
 *   3. Run ONE bounded pass of Videos `DELETE <videosApiUrl>/api/privacy/data` per HTTP
 *      request and return `resumeToken` when `complete: false`. The browser drives
 *      subsequent passes with live progress and fresh tokens on every pass, avoiding
 *      long-running Worker disconnects and preserving resume state across retries.
 *   4. Once `complete: true`, delete the Auth account via `DELETE <authServerUrl>/account`.
 *      If Auth still refuses with 401 after Videos data is erased, return a distinct
 *      `content_erased_reauth_required` state so the user is told their content was
 *      removed and signing in again finishes deleting the sign-in account.
 */
import type { AppEnv } from "./apps";

/** Must match Auth's REAUTH_MAX_AGE_SECONDS (apps/auth/src/routes/account-routes.ts). */
export const REAUTH_MAX_AGE_SECONDS = 600;

/**
 * Stricter pre-check window (5 minutes) for pass 1, leaving a 5-minute safety margin
 * inside Auth's 600s limit before touching any user content.
 */
export const PRECHECK_REAUTH_MAX_AGE_SECONDS = 300;

/**
 * Continuation window (570s — Auth's 600s limit minus 30s skew margin) used on resume passes
 * after pass 1 has already started erasing content, so a multi-pass erase does not bounce
 * to re-auth at 305s while Auth still accepts the sign-in.
 */
export const CONTINUATION_REAUTH_MAX_AGE_SECONDS = 570;

/** Matches AlUmmahNow PrivacyService.MAX_ERASURE_PASSES. */
export const MAX_ERASURE_PASSES = 50;

export interface DeleteProgressState {
  stage: "in_progress" | "content_erased";
  resumeToken?: string;
  updatedAt: number;
}

export const VIDEOS_API_URLS: Record<AppEnv, string | null> = {
  production: "https://videos.api.alummahnow.net",
  qa: "https://videos.api.qa.alummahnow.net",
  stage: "https://videos.api.stage.alummahnow.net",
  local: "http://localhost:3086",
};

export function resolveVideosApiUrl(configured: string | undefined, appEnv: AppEnv | null): string | null {
  const trimmed = configured?.trim().replace(/\/+$/, "");
  if (trimmed) return trimmed;
  return appEnv ? VIDEOS_API_URLS[appEnv] : null;
}

/** Decode a JWT payload (unverified — signature was already verified by Auth/OpenAuth). */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const json = atob(padded);
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Extract `properties.id` from an OpenAuth access token when present. */
export function tokenUserIdOf(accessToken: string): string | null {
  const payload = decodeJwtPayload(accessToken);
  const props = payload?.properties;
  if (props && typeof props === "object" && !Array.isArray(props)) {
    const id = (props as Record<string, unknown>).id;
    if (typeof id === "string" && id.trim().length > 0) return id;
  }
  return null;
}

/** True when the access token's `auth_time` is within `maxAgeSeconds` of `nowMs` and not implausibly in the future. */
export function isRecentSignIn(
  accessToken: string,
  nowMs = Date.now(),
  maxAgeSeconds = PRECHECK_REAUTH_MAX_AGE_SECONDS,
): boolean {
  const payload = decodeJwtPayload(accessToken);
  const authTime = payload?.auth_time;
  if (typeof authTime !== "number" || !Number.isFinite(authTime)) return false;
  const ageSeconds = nowMs / 1000 - authTime;
  return ageSeconds >= -60 && ageSeconds <= maxAgeSeconds;
}

export type EraseAccountOutcome =
  | { ok: true; complete: true; userId?: string; deletedAt?: number }
  | { ok: true; complete: false; resumeToken: string }
  | {
      ok: false;
      status: number;
      error: string;
      maxAge?: number;
      detail?: string;
      contentErased?: boolean;
      resumeToken?: string;
    };

/**
 * Executes a single bounded step of account deletion:
 *   - Runs one Videos `DELETE /api/privacy/data` pass (forwarding `resumeToken` when given).
 *   - If Videos reports `complete: false`, returns `{ ok: true, complete: false, resumeToken }`
 *     immediately so the caller can issue the next pass with a fresh token and progress UI.
 *   - If Videos reports `complete: true`, deletes the Auth account via `DELETE /account`.
 */
export async function orchestrateAccountDeletion(opts: {
  accessToken: string;
  expectedUserId?: string;
  authServerUrl: string;
  videosApiUrl: string | null;
  resumeToken?: string;
  /** True when a prior pass already completed Videos erasure and only Auth DELETE /account remains. */
  skipVideosErasure?: boolean;
  /** True when erasure already started in an earlier pass (uses Auth's 600s window with a 30s margin). */
  erasureStarted?: boolean;
  nowMs?: number;
  fetchFn?: typeof fetch;
}): Promise<EraseAccountOutcome> {
  const fetchFn = opts.fetchFn ?? fetch;
  const nowMs = opts.nowMs ?? Date.now();
  const isContinuation = Boolean(opts.resumeToken || opts.skipVideosErasure || opts.erasureStarted);
  const reauthWindow = isContinuation ? CONTINUATION_REAUTH_MAX_AGE_SECONDS : PRECHECK_REAUTH_MAX_AGE_SECONDS;

  // Fail closed: the token MUST carry properties.id matching expectedUserId before any upstream call.
  if (opts.expectedUserId !== undefined) {
    const tokenUid = tokenUserIdOf(opts.accessToken);
    if (!tokenUid || tokenUid !== opts.expectedUserId) {
      return {
        ok: false,
        status: 409,
        error: "account_mismatch",
        detail: "Signed-in account changed; reload and confirm again.",
      };
    }
  }

  // Check step-up freshness BEFORE erasing any Videos data (300s for pass 1; 570s for continuation passes).
  if (!isRecentSignIn(opts.accessToken, nowMs, reauthWindow)) {
    if (opts.skipVideosErasure) {
      return {
        ok: false,
        status: 409,
        error: "content_erased_reauth_required",
        contentErased: true,
        maxAge: REAUTH_MAX_AGE_SECONDS,
        detail: "Content removed; sign in again to finish deleting your account.",
      };
    }
    return {
      ok: false,
      status: 401,
      error: "insufficient_user_authentication",
      maxAge: reauthWindow,
      detail: "Sign in again to delete your account",
      ...(opts.resumeToken ? { resumeToken: opts.resumeToken } : {}),
    };
  }

  if (!opts.skipVideosErasure) {
    // Fail closed when Videos API is unconfigured so Auth is never deleted while Videos data stays behind.
    if (!opts.videosApiUrl) {
      return { ok: false, status: 503, error: "videos_api_unconfigured" };
    }

    // Step 1: Run one bounded Videos erasure pass while the user's access token is still valid.
    let res: Response;
    try {
      res = await fetchFn(`${opts.videosApiUrl}/api/privacy/data`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${opts.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          confirm: "DELETE",
          ...(opts.resumeToken ? { resumeToken: opts.resumeToken } : {}),
        }),
      });
    } catch {
      return {
        ok: false,
        status: 502,
        error: "videos_erasure_failed",
        ...(opts.resumeToken ? { resumeToken: opts.resumeToken } : {}),
      };
    }

    if (res.status === 401) {
      const errBody = (await res.json().catch(() => null)) as { error?: unknown } | null;
      if (errBody?.error === "insufficient_user_authentication") {
        return {
          ok: false,
          status: 401,
          error: "insufficient_user_authentication",
          maxAge: reauthWindow,
          ...(opts.resumeToken ? { resumeToken: opts.resumeToken } : {}),
        };
      }
      return {
        ok: false,
        status: 502,
        error: "videos_erasure_failed",
        ...(opts.resumeToken ? { resumeToken: opts.resumeToken } : {}),
      };
    }
    if (!res.ok) {
      return {
        ok: false,
        status: 502,
        error: "videos_erasure_failed",
        ...(opts.resumeToken ? { resumeToken: opts.resumeToken } : {}),
      };
    }

    const data = (await res.json().catch(() => null)) as { complete?: unknown; resumeToken?: unknown } | null;
    const complete = data?.complete === true;
    const nextResumeToken = typeof data?.resumeToken === "string" && data.resumeToken.length > 0 ? data.resumeToken : undefined;

    if (!complete) {
      if (!nextResumeToken) {
        return {
          ok: false,
          status: 502,
          error: "videos_erasure_incomplete",
          ...(opts.resumeToken ? { resumeToken: opts.resumeToken } : {}),
        };
      }
      return { ok: true, complete: false, resumeToken: nextResumeToken };
    }
  }

  // Step 2: Videos erasure is complete; delete the sign-in account on Auth (revokes all sessions & refresh tokens, 30-day purge).
  let authRes: Response;
  try {
    authRes = await fetchFn(`${opts.authServerUrl}/account`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${opts.accessToken}` },
    });
  } catch {
    return { ok: false, status: 502, error: "account_deletion_failed", contentErased: true };
  }

  const body = (await authRes.json().catch(() => ({}))) as {
    error?: string;
    error_description?: string;
    max_age?: number;
    userId?: string;
    deletedAt?: number;
  };

  if (authRes.status === 401) {
    return {
      ok: false,
      status: 409,
      error: "content_erased_reauth_required",
      contentErased: true,
      maxAge: typeof body.max_age === "number" ? body.max_age : REAUTH_MAX_AGE_SECONDS,
      detail: body.error_description || "Content removed; sign in again to finish deleting your account.",
    };
  }
  if (!authRes.ok) {
    return {
      ok: false,
      status: authRes.status >= 400 && authRes.status < 500 ? authRes.status : 502,
      error: body.error || "account_deletion_failed",
      contentErased: true,
      detail: body.error_description,
    };
  }

  return { ok: true, complete: true, userId: body.userId, deletedAt: body.deletedAt };
}
