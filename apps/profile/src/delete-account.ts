/**
 * Self-service account deletion for the profile app (AlUmmahNowAuth#532): the order of the calls.
 *
 * Reuses the existing erase endpoints, no second erase backend. One call of orchestrateAccountDeletion is one
 * bounded step; the page repeats it until the account is gone:
 *   1. Before anything: the token must be the confirmed account's (an account switch in another tab can never
 *      delete the other account) and the sign-in recent enough.
 *   2. Record that a deletion has started (delete-progress.ts). Without that record nothing is called.
 *   3. One Videos `DELETE /api/privacy/data` pass. Always, also when an earlier attempt finished the erase and only
 *      Auth failed: the account was live meanwhile, and what it added since must go too. The erase is idempotent.
 *      What it could not remove is shown, and the person decides, before the next step.
 *   4. After `complete: true`, record it and call Auth `DELETE /account`. Auth's own row settles a lost answer.
 */
import type { AppEnv } from "./apps";
import type { DeleteProgress, Leftover } from "./delete-progress";

/** Must match Auth's REAUTH_MAX_AGE_SECONDS (apps/auth/src/routes/account-routes.ts). */
export const REAUTH_MAX_AGE_SECONDS = 600;

/** First pass: leaves five minutes inside Auth's limit before any content is touched. */
export const PRECHECK_REAUTH_MAX_AGE_SECONDS = 300;

/** Once a deletion has started: Auth's limit less 30 s, so a long erase is not stopped half-way. */
export const CONTINUATION_REAUTH_MAX_AGE_SECONDS = 570;

/** Wait to ask for when Videos says "later" without a usable Retry-After, and the longest one passed on. */
export const DEFAULT_RETRY_AFTER_SECONDS = 300;
const MAX_RETRY_AFTER_SECONDS = 3600;

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

/** The progress record and Auth's row, as one deletion sees them. */
export interface DeletionState {
  read(): Promise<DeleteProgress | null>;
  write(p: DeleteProgress): Promise<void>;
  /** Only the very record given, if it is still the stored one. */
  remove(p: DeleteProgress): Promise<void>;
  accountDeleted(): Promise<boolean>;
}

export type EraseAccountOutcome =
  | { ok: true; complete: true; leftover?: Leftover; deletedAt?: number }
  | { ok: true; complete: false; restarted: boolean }
  /** The erase finished but left something behind: the person decides before the account goes. */
  | { ok: true; complete: false; leftover: Leftover }
  | {
      ok: false;
      status: number;
      error: string;
      maxAge?: number;
      retryAfter?: number;
      /** Something of the account may already be gone. */
      started: boolean;
      /** An erase pass over everything finished; only the sign-in account is left. */
      contentErased?: boolean;
    };

/** Seconds of a Retry-After header (number or date), within reason. */
export function retryAfterSeconds(header: string | null, nowMs: number): number {
  const value = header?.trim() ?? "";
  const seconds = /^\d+$/.test(value) ? Number(value) : (Date.parse(value) - nowMs) / 1000;
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_RETRY_AFTER_SECONDS;
  return Math.min(Math.ceil(seconds), MAX_RETRY_AFTER_SECONDS);
}

/** What a Videos pass left in place (`errors` of its summary). */
export function leftoverOf(errors: unknown): Leftover | undefined {
  if (!Array.isArray(errors) || errors.length === 0) return undefined;
  return errors.some((e) => typeof e === "string" && e.startsWith("channel_unreadable:")) ? "channel" : "other";
}

const worse = (a: Leftover | undefined, b: Leftover | undefined): Leftover | undefined =>
  a === "channel" || b === "channel" ? "channel" : (a ?? b);

/** Refused before the erase handler ran: this pass removed nothing. */
const REFUSED = new Set([400, 401, 403, 404, 429]);

export async function orchestrateAccountDeletion(opts: {
  accessToken: string;
  expectedUserId: string;
  authServerUrl: string;
  videosApiUrl: string | null;
  state: DeletionState;
  /** What the person was told stays behind and went on with. */
  acceptLeftover?: Leftover;
  nowMs?: number;
  fetchFn?: typeof fetch;
}): Promise<EraseAccountOutcome> {
  const fetchFn = opts.fetchFn ?? fetch;
  const nowMs = opts.nowMs ?? Date.now();
  const { state } = opts;

  if (tokenUserIdOf(opts.accessToken) !== opts.expectedUserId) {
    return { ok: false, status: 409, error: "account_mismatch", started: false };
  }

  let saved: DeleteProgress | null;
  try {
    saved = await state.read();
  } catch (error) {
    console.error("Account deletion progress could not be read", error instanceof Error ? error.message : String(error));
    return { ok: false, status: 503, error: "progress_unavailable", started: false };
  }
  // A finished deletion of an account that is live again (restored by staff): a new one
  if (saved?.stage === "deleted") saved = null;
  const startedBefore = saved !== null;

  const maxAge = startedBefore ? CONTINUATION_REAUTH_MAX_AGE_SECONDS : PRECHECK_REAUTH_MAX_AGE_SECONDS;
  if (!isRecentSignIn(opts.accessToken, nowMs, maxAge)) {
    return { ok: false, status: 401, error: "insufficient_user_authentication", maxAge, started: startedBefore };
  }
  // Never delete the sign-in account alone
  if (!opts.videosApiUrl) return { ok: false, status: 503, error: "videos_api_unconfigured", started: startedBefore };

  // Only a run that is not finished goes on; after a finished one the erase starts from the beginning
  const resumeToken = saved?.stage === "started" ? saved.resumeToken : undefined;
  let record: DeleteProgress = {
    stage: "started",
    ...(resumeToken ? { resumeToken, ...(saved?.leftover ? { leftover: saved.leftover } : {}) } : {}),
    startedAt: saved?.startedAt ?? nowMs,
    updatedAt: nowMs,
  };
  try {
    await state.write(record);
  } catch (error) {
    console.error("Account deletion not started: its record could not be written", error instanceof Error ? error.message : String(error));
    return { ok: false, status: 503, error: "progress_unavailable", started: startedBefore };
  }
  /** Nothing was erased by this pass: a record made for it would say otherwise. */
  const nothingErased = async (): Promise<boolean> => {
    if (startedBefore) return true;
    try {
      await state.remove(record);
      return false;
    } catch {
      return true;
    }
  };

  // Videos: one bounded pass, with the person's own token
  let res: Response;
  try {
    res = await fetchFn(`${opts.videosApiUrl}/api/privacy/data`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${opts.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "DELETE", ...(resumeToken ? { resumeToken } : {}) }),
    });
  } catch {
    return { ok: false, status: 502, error: "videos_erasure_failed", started: true };
  }
  if (REFUSED.has(res.status)) {
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    const started = await nothingErased();
    if (res.status === 401 && body?.error === "insufficient_user_authentication") {
      return { ok: false, status: 401, error: "insufficient_user_authentication", maxAge, started };
    }
    if (res.status === 429) {
      return { ok: false, status: 503, error: "videos_busy", retryAfter: retryAfterSeconds(res.headers.get("Retry-After"), nowMs), started };
    }
    return { ok: false, status: 502, error: "videos_erasure_refused", started };
  }
  if (res.status === 503) {
    const body = (await res.json().catch(() => null)) as { code?: unknown } | null;
    return {
      ok: false,
      status: 503,
      error: body?.code === "resume_unavailable" ? "resume_unavailable" : "videos_busy",
      retryAfter: retryAfterSeconds(res.headers.get("Retry-After"), nowMs),
      started: true,
    };
  }
  if (!res.ok) return { ok: false, status: 502, error: "videos_erasure_failed", started: true };

  const data = (await res.json().catch(() => null)) as {
    complete?: unknown;
    resumeToken?: unknown;
    restarted?: unknown;
    errors?: unknown;
  } | null;
  const restarted = data?.restarted === true;
  // A run that began again reports again what it cannot remove
  const leftover = worse(restarted ? undefined : record.leftover, leftoverOf(data?.errors));
  const next = typeof data?.resumeToken === "string" && data.resumeToken ? data.resumeToken : undefined;
  if (data?.complete !== true && !next) return { ok: false, status: 502, error: "videos_erasure_incomplete", started: true };

  record = {
    stage: data?.complete === true ? "content_erased" : "started",
    ...(data?.complete === true ? {} : { resumeToken: next }),
    ...(leftover ? { leftover } : {}),
    startedAt: record.startedAt,
    updatedAt: nowMs,
  };
  try {
    await state.write(record);
  } catch (error) {
    // The earlier record still says "started": the next attempt repeats this pass
    console.error("Account deletion progress could not be written", error instanceof Error ? error.message : String(error));
    return { ok: false, status: 503, error: "progress_unavailable", started: true };
  }
  if (data?.complete !== true) return { ok: true, complete: false, restarted };
  // Never more than what they were told about
  if (leftover && opts.acceptLeftover !== leftover && opts.acceptLeftover !== "channel") return { ok: true, complete: false, leftover };

  // Auth: the account, its sessions and refresh tokens; the purge follows in 30 days
  const done = (deletedAt?: unknown): EraseAccountOutcome => ({
    ok: true,
    complete: true,
    ...(leftover ? { leftover } : {}),
    ...(typeof deletedAt === "number" ? { deletedAt } : {}),
  });
  /** Auth may have committed although its answer says otherwise or never came: its own row decides. */
  const settled = async (): Promise<boolean> => {
    try {
      return await state.accountDeleted();
    } catch {
      return false;
    }
  };
  let authRes: Response;
  try {
    authRes = await fetchFn(`${opts.authServerUrl}/account`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${opts.accessToken}` },
    });
  } catch {
    if (await settled()) return done();
    return { ok: false, status: 502, error: "account_deletion_failed", started: true, contentErased: !leftover };
  }
  const body = (await authRes.json().catch(() => null)) as { deleted?: unknown; deletedAt?: unknown; max_age?: unknown; error?: unknown } | null;
  if (authRes.ok && body?.deleted === true) return done(body.deletedAt);
  // No account under the id whose content was erased just now: it is gone already
  if (authRes.status === 404 && body?.error === "not_found") return done();
  if (await settled()) return done();
  if (authRes.status === 401) {
    return {
      ok: false,
      status: 409,
      error: "content_erased_reauth_required",
      maxAge: typeof body?.max_age === "number" ? body.max_age : REAUTH_MAX_AGE_SECONDS,
      started: true,
      contentErased: !leftover,
    };
  }
  return { ok: false, status: 502, error: "account_deletion_failed", started: true, contentErased: !leftover };
}
