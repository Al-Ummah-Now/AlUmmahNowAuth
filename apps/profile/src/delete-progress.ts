/**
 * What is kept about an account deletion while it runs, in the auth D1 database.
 *
 * The record is written before the first erase call, so a first pass that fails, a lost connection or a closed
 * tab never looks as if nothing had happened. It lives in `openauth_atomic` (a key/value table every location
 * reads current; KV can answer "missing" for a minute after a write) and has no expiry: it goes when the deletion
 * is done. Losing it is safe all the same: the next attempt erases from the start again, which is idempotent.
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
  /** Of the attempt that wrote it: no two records are equal, so an attempt only ever removes its own. */
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

/** Throws when the database cannot be read: "unknown" must never look like "nothing started". */
export async function readDeleteProgress(db: D1Database, userId: string, nowMs = Date.now()): Promise<DeleteProgress | null> {
  const raw = await getValue(db, progressKey(userId), nowMs);
  if (raw === null) return null;
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

export async function writeDeleteProgress(db: D1Database, userId: string, p: DeleteProgress): Promise<void> {
  await putValue(db, progressKey(userId), p, p.stage === "deleted" ? p.updatedAt + DELETED_TTL_MS : null);
}

/**
 * Writes the first record of a deletion. True when there was none (or only a finished one's, which has an expiry):
 * this attempt made it. Otherwise another attempt has started meanwhile; the record is replaced all the same, so
 * that the other attempt can no longer remove it.
 */
export async function startDeleteProgress(db: D1Database, userId: string, p: DeleteProgress): Promise<boolean> {
  const created = await db
    .prepare(
      `INSERT INTO openauth_atomic (key, value, expires_at) VALUES (?1, ?2, NULL)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = NULL WHERE openauth_atomic.expires_at IS NOT NULL
       RETURNING key`,
    )
    .bind(progressKey(userId), JSON.stringify(p))
    .first();
  if (created) return true;
  await writeDeleteProgress(db, userId, p);
  return false;
}

/**
 * The account is proven gone: what is left of the record expires in a day, without the resume token. Nothing is
 * written when there was no record to keep and no erase to speak of.
 */
export async function settleDeleteProgress(db: D1Database, userId: string, before: DeleteProgress | null, proof: DoneProof, nowMs = Date.now()): Promise<void> {
  if (before?.stage === "deleted" || (!before && !proof.erased)) return;
  await writeDeleteProgress(db, userId, {
    stage: "deleted",
    ...(proof.leftover ? { leftover: proof.leftover } : {}),
    ...(proof.erased ? {} : { erased: false }),
    startedAt: before?.startedAt ?? nowMs,
    updatedAt: nowMs,
  });
}

/** Removes exactly the record `p` (written by this request), never one another tab has written since. */
export async function removeDeleteProgress(db: D1Database, userId: string, p: DeleteProgress): Promise<void> {
  await db.prepare(`DELETE FROM openauth_atomic WHERE key = ?1 AND value = ?2`).bind(progressKey(userId), JSON.stringify(p)).run();
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
