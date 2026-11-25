/**
 * What is kept about an account deletion while it runs, in the auth D1 database.
 *
 * The record is written before the first erase call, so a first pass that fails, a lost connection or a closed
 * tab never looks as if nothing had happened. It lives in `openauth_atomic` (a key/value table every location
 * reads current; KV can answer "missing" for a minute after a write) and has no expiry: it goes when the deletion
 * is done. Losing it is safe all the same: the next attempt erases from the start again, which is idempotent.
 *
 * Several attempts can run at once (two tabs, a retry). Every write is a compare-and-set on the exact text the
 * attempt read or wrote last, so none overwrites or removes what another has saved meanwhile; on a conflict the
 * two records are merged (delete-account.ts). A settled record (stage deleted) is never touched by an attempt
 * on a deleted account.
 *
 * Auth's account purge removes the record with the account (apps/auth/src/deletions/kinds.ts).
 */

/** What the Videos erase reported it could not remove. "channel": a channel it could not read; staff finish it. */
export type Leftover = "channel" | "other";

export interface DeleteProgress {
  /** started: some content may be gone. content_erased: an erase finished. deleted: the account went too. */
  stage: "started" | "content_erased" | "deleted";
  /** Opaque, from api-videos and bound to the account there; handed back unread. */
  resumeToken?: string;
  leftover?: Leftover;
  /** stage deleted only: false when the account went some other way, so nothing is said about its content. */
  erased?: boolean;
  /** Of the attempt that wrote it: no two records have the same text, so an attempt only replaces or removes its own. */
  attempt?: string;
  startedAt: number;
  updatedAt: number;
}

/** What the "account deleted" page may say; stored with the one-time proof. */
export interface DoneProof {
  /** False when the account was deleted some other way: nothing is said about Videos content then. */
  erased: boolean;
  leftover?: Leftover;
}

/** Kept a day after the deletion, so a lost last answer can still be settled. */
const DELETED_TTL_MS = 24 * 60 * 60 * 1000;
const DONE_PROOF_TTL_MS = 10 * 60 * 1000;

export const progressKey = (userId: string) => `profile:delete-account::${userId}`;
const doneKey = (nonce: string) => `profile:delete-done::${nonce}`;

async function getValue(db: D1Database, key: string, nowMs: number): Promise<string | null> {
  const row = await db
    .prepare(`SELECT value FROM openauth_atomic WHERE key = ?1 AND (expires_at IS NULL OR expires_at > ?2)`)
    .bind(key, nowMs)
    .first<{ value: string }>();
  return row?.value ?? null;
}

async function putValue(db: D1Database, key: string, value: unknown, expiresAt: number | null): Promise<void> {
  await db
    .prepare(
      `INSERT INTO openauth_atomic (key, value, expires_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`,
    )
    .bind(key, JSON.stringify(value), expiresAt)
    .run();
}

const leftoverOf = (value: unknown): Leftover | undefined => (value === "channel" || value === "other" ? value : undefined);

function parseProgress(raw: string, nowMs: number): DeleteProgress {
  let p: Partial<DeleteProgress> | null = null;
  try {
    p = JSON.parse(raw) as Partial<DeleteProgress> | null;
  } catch {
    // an unreadable record still says that a deletion started
  }
  const stage = p?.stage === "content_erased" || p?.stage === "deleted" ? p.stage : "started";
  const leftover = leftoverOf(p?.leftover);
  return {
    stage,
    ...(typeof p?.resumeToken === "string" && p.resumeToken ? { resumeToken: p.resumeToken } : {}),
    ...(leftover ? { leftover } : {}),
    ...(stage === "deleted" && p?.erased === false ? { erased: false } : {}),
    startedAt: typeof p?.startedAt === "number" ? p.startedAt : nowMs,
    updatedAt: typeof p?.updatedAt === "number" ? p.updatedAt : nowMs,
  };
}

/** A stored record and its exact text, which a later write or removal must still find. */
export interface StoredProgress {
  record: DeleteProgress;
  raw: string;
}

/** Throws when the database cannot be read: "unknown" must never look like "nothing started". */
export async function readStoredProgress(db: D1Database, userId: string, nowMs = Date.now()): Promise<StoredProgress | null> {
  const raw = await getValue(db, progressKey(userId), nowMs);
  return raw === null ? null : { record: parseProgress(raw, nowMs), raw };
}

export async function readDeleteProgress(db: D1Database, userId: string, nowMs = Date.now()): Promise<DeleteProgress | null> {
  return (await readStoredProgress(db, userId, nowMs))?.record ?? null;
}

/**
 * Compare-and-set: writes `p` only where `expected` is still stored (null: only where nothing is). The new text,
 * or null when something else is there.
 */
export async function putDeleteProgress(db: D1Database, userId: string, p: DeleteProgress, expected: string | null, nowMs = Date.now()): Promise<string | null> {
  const raw = JSON.stringify(p);
  const statement =
    expected === null
      ? db
          .prepare(
            `INSERT INTO openauth_atomic (key, value, expires_at) VALUES (?1, ?2, NULL)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = NULL
             WHERE openauth_atomic.expires_at IS NOT NULL AND openauth_atomic.expires_at <= ?3
             RETURNING key`,
          )
          .bind(progressKey(userId), raw, nowMs)
      : db
          .prepare(
            `UPDATE openauth_atomic SET value = ?2, expires_at = NULL
             WHERE key = ?1 AND value = ?4 AND (expires_at IS NULL OR expires_at > ?3) RETURNING key`,
          )
          .bind(progressKey(userId), raw, nowMs, expected);
  return (await statement.first()) ? raw : null;
}

/** Removes the record only where `expected` is still stored; whether it did. */
export async function removeDeleteProgress(db: D1Database, userId: string, expected: string): Promise<boolean> {
  return (
    (await db.prepare(`DELETE FROM openauth_atomic WHERE key = ?1 AND value = ?2 RETURNING key`).bind(progressKey(userId), expected).first()) !== null
  );
}

/**
 * The account is proven gone: its record keeps what may be said for a day, without the resume token. A record
 * that is settled already stays as it is, and nothing is made where there is no record and no erase to speak of.
 */
export async function settleDeleteProgress(db: D1Database, userId: string, proof: DoneProof, nowMs = Date.now()): Promise<void> {
  const settled: DeleteProgress = {
    stage: "deleted",
    ...(proof.leftover ? { leftover: proof.leftover } : {}),
    ...(proof.erased ? {} : { erased: false }),
    startedAt: nowMs,
    updatedAt: nowMs,
  };
  const value = JSON.stringify(settled);
  const expiresAt = nowMs + DELETED_TTL_MS;
  if (proof.erased) {
    await db
      .prepare(
        `INSERT INTO openauth_atomic (key, value, expires_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at
         WHERE openauth_atomic.expires_at IS NULL OR openauth_atomic.expires_at <= ?4`,
      )
      .bind(progressKey(userId), value, expiresAt, nowMs)
      .run();
  } else {
    await db
      .prepare(`UPDATE openauth_atomic SET value = ?2, expires_at = ?3 WHERE key = ?1 AND expires_at IS NULL`)
      .bind(progressKey(userId), value, expiresAt)
      .run();
  }
}

/** Whether Auth has deleted this account (a primary-key read of Auth's own row). */
export async function accountDeleted(db: D1Database, userId: string): Promise<boolean> {
  const row = await db.prepare(`SELECT status FROM users WHERE id = ?1`).bind(userId).first<{ status: string }>();
  return row?.status === "deleted";
}

export async function putDoneProof(db: D1Database, nonce: string, proof: DoneProof, nowMs = Date.now()): Promise<void> {
  await putValue(db, doneKey(nonce), proof, nowMs + DONE_PROOF_TTL_MS);
}

/** The proof behind a done cookie, once. */
export async function takeDoneProof(db: D1Database, nonce: string, nowMs = Date.now()): Promise<DoneProof | null> {
  if (!/^[0-9a-f-]{36}$/.test(nonce)) return null;
  const row = await db
    .prepare(`DELETE FROM openauth_atomic WHERE key = ?1 AND expires_at > ?2 RETURNING value`)
    .bind(doneKey(nonce), nowMs)
    .first<{ value: string }>();
  if (!row) return null;
  const p = JSON.parse(row.value) as Partial<DoneProof>;
  const leftover = leftoverOf(p.leftover);
  return { erased: p.erased === true, ...(leftover ? { leftover } : {}) };
}

/**
 * The switch of the whole feature: `auth_settings['account_deletion']` = {"on": false} turns the page, the API and
 * the profile card off (no row: on, as the store listings need the page). Read by primary key, cached 30 s.
 */
export const ACCOUNT_DELETION_SETTING = "account_deletion";
const SWITCH_CACHE_MS = 30_000;
let switchCache: { at: number; on: boolean } | null = null;

export async function accountDeletionOn(db: D1Database, nowMs = Date.now()): Promise<boolean> {
  if (switchCache && nowMs - switchCache.at >= 0 && nowMs - switchCache.at < SWITCH_CACHE_MS) return switchCache.on;
  let on: boolean;
  try {
    const row = await db.prepare(`SELECT value FROM auth_settings WHERE key = ?1`).bind(ACCOUNT_DELETION_SETTING).first<{ value: string }>();
    on = !row || (JSON.parse(row.value) as { on?: unknown } | null)?.on !== false;
  } catch (error) {
    // Unreadable: the last answer, else off. Nothing is deleted while the switch cannot be read
    console.error("Account deletion switch could not be read", error instanceof Error ? error.message : String(error));
    return switchCache?.on ?? false;
  }
  switchCache = { at: nowMs, on };
  return on;
}

/** Tests only. */
export function clearAccountDeletionSwitchCache(): void {
  switchCache = null;
}
