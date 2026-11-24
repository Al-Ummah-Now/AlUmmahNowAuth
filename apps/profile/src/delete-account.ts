/**
 * Self-service account deletion orchestration for the profile web app (AlUmmahNowAuth#532).
 *
 * Reuses the existing erase endpoints without introducing a second erase backend:
 *   1. Verify the access token's `auth_time` is recent (<= REAUTH_MAX_AGE_SECONDS) BEFORE
 *      touching any user content, so a stale session triggers step-up sign-in first.
 *   2. Erase Videos data via `DELETE <videosApiUrl>/api/privacy/data` (resumable loop
 *      until `complete: true`). If Videos erasure fails, stop before deleting Auth so
 *      content is never orphaned.
 *   3. Delete the Auth account via `DELETE <authServerUrl>/account`.
 */
import type { AppEnv } from "./apps";

/** Must match Auth's REAUTH_MAX_AGE_SECONDS (apps/auth/src/routes/account-routes.ts). */
export const REAUTH_MAX_AGE_SECONDS = 600;

/** Matches AlUmmahNow PrivacyService.MAX_ERASURE_PASSES. */
export const MAX_ERASURE_PASSES = 50;

export const VIDEOS_API_URLS: Record<AppEnv, string | null> = {
  production: "https://videos.api.alummahnow.net",
  qa: "https://videos.api.qa.alummahnow.net",
  stage: "https://videos.api.stage.alummahnow.net",
  local: "http://localhost:8787",
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

/** True when the access token's `auth_time` is within `maxAgeSeconds` of `nowMs`. */
export function isRecentSignIn(
  accessToken: string,
  nowMs = Date.now(),
  maxAgeSeconds = REAUTH_MAX_AGE_SECONDS,
): boolean {
  const payload = decodeJwtPayload(accessToken);
  const authTime = payload?.auth_time;
  if (typeof authTime !== "number" || !Number.isFinite(authTime)) return false;
  return nowMs / 1000 - authTime <= maxAgeSeconds;
}

export type EraseAccountOutcome =
  | { ok: true; userId?: string; deletedAt?: number }
  | { ok: false; status: number; error: string; maxAge?: number; detail?: string };

export async function orchestrateAccountDeletion(opts: {
  accessToken: string;
  authServerUrl: string;
  videosApiUrl: string | null;
  nowMs?: number;
  fetchFn?: typeof fetch;
}): Promise<EraseAccountOutcome> {
  const fetchFn = opts.fetchFn ?? fetch;
  const nowMs = opts.nowMs ?? Date.now();

  // Check step-up freshness BEFORE erasing any Videos data so a stale session never wipes content first.
  if (!isRecentSignIn(opts.accessToken, nowMs)) {
    return {
      ok: false,
      status: 401,
      error: "insufficient_user_authentication",
      maxAge: REAUTH_MAX_AGE_SECONDS,
      detail: "Sign in again to delete your account",
    };
  }

  // Step 1: Erase Videos data while the user's access token is still valid.
  if (opts.videosApiUrl) {
    let complete = false;
    let resumeToken: string | undefined;
    for (let pass = 0; pass < MAX_ERASURE_PASSES && !complete; pass++) {
      let res: Response;
      try {
        res = await fetchFn(`${opts.videosApiUrl}/api/privacy/data`, {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${opts.accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ confirm: "DELETE", ...(resumeToken ? { resumeToken } : {}) }),
        });
      } catch {
        return { ok: false, status: 502, error: "videos_erasure_failed" };
      }

      if (res.status === 401) {
        return {
          ok: false,
          status: 401,
          error: "insufficient_user_authentication",
          maxAge: REAUTH_MAX_AGE_SECONDS,
        };
      }
      if (!res.ok) {
        return { ok: false, status: 502, error: "videos_erasure_failed" };
      }
      const data = (await res.json().catch(() => null)) as { complete?: unknown; resumeToken?: unknown } | null;
      complete = data?.complete === true;
      resumeToken = typeof data?.resumeToken === "string" ? data.resumeToken : undefined;
      if (!complete && !resumeToken) {
        return { ok: false, status: 502, error: "videos_erasure_incomplete" };
      }
    }
    if (!complete) {
      return { ok: false, status: 502, error: "videos_erasure_incomplete" };
    }
  }

  // Step 2: Delete the sign-in account on Auth (revokes all sessions & refresh tokens, 30-day purge).
  let authRes: Response;
  try {
    authRes = await fetchFn(`${opts.authServerUrl}/account`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${opts.accessToken}` },
    });
  } catch {
    return { ok: false, status: 502, error: "account_deletion_failed" };
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
      status: 401,
      error: body.error || "insufficient_user_authentication",
      maxAge: typeof body.max_age === "number" ? body.max_age : REAUTH_MAX_AGE_SECONDS,
      detail: body.error_description,
    };
  }
  if (!authRes.ok) {
    return {
      ok: false,
      status: authRes.status >= 400 && authRes.status < 500 ? authRes.status : 502,
      error: body.error || "account_deletion_failed",
      detail: body.error_description,
    };
  }

  return { ok: true, userId: body.userId, deletedAt: body.deletedAt };
}
