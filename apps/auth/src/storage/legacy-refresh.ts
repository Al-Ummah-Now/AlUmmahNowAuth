/**
 * Refresh tokens issued before 2026-11-10 still live in KV (AUTH_STORAGE) with a
 * one-year TTL; since then every refresh token is in D1 (openauth_atomic). While
 * KV may hold one, openauth reads KV after a D1 miss, deletes the KV key next to
 * every D1 delete and LISTs KV on "sign out everywhere" (removeAllRefreshTokens):
 * about 9k KV lists and 36k KV deletes a day on QA for keys that mostly are not there.
 *
 * The hourly cron moves the KV tokens into D1 (`adoptLegacyRefreshTokens`) and,
 * once a KV list finds none, writes a marker row. From then on the storage skips
 * KV for refresh-token keys (`kvMayHoldRefreshTokens` is false). Nothing writes a
 * refresh token to KV any more, so the marker never goes stale.
 */
import { joinKey, splitKey, type AtomicStorageAdapter } from '@al-ummah-now/openauth/storage/storage';

export const REFRESH_PREFIX = 'oauth:refresh';
/** openauth_atomic row written when KV holds no refresh token. */
export const ADOPTED_MARKER = ['migrations', 'kv_refresh_adopted'];

const RECHECK_MS = 10 * 60 * 1000;
let adopted = false;
let checkedAt = 0;
let pending: Promise<boolean> | null = null;

/** Forget the isolate's answer (tests). */
export function resetLegacyRefreshState(): void {
	adopted = false;
	checkedAt = 0;
	pending = null;
}

/**
 * Whether KV may still hold a refresh token: true until the marker row exists.
 * One D1 point read per isolate (then every 10 min until adopted; never after).
 * A failed read answers true, the old behaviour.
 */
export async function kvMayHoldRefreshTokens(db: D1Database): Promise<boolean> {
	if (adopted) return false;
	if (Date.now() - checkedAt < RECHECK_MS) return true;
	pending ??= db
		.prepare('SELECT 1 AS found FROM openauth_atomic WHERE key = ?')
		.bind(joinKey(ADOPTED_MARKER))
		.first<{ found: number }>()
		.then((row) => {
			adopted = !!row;
			checkedAt = Date.now();
			return !adopted;
		})
		.catch(() => true)
		.finally(() => {
			pending = null;
		});
	return pending;
}

export interface AdoptResult {
	moved: number;
	done: boolean;
}

/**
 * Moves up to `limit` KV refresh tokens into the atomic store (a live D1 row with
 * the same key wins) and deletes them from KV; writes the marker when KV has none.
 */
export async function adoptLegacyRefreshTokens(
	kv: KVNamespace,
	atomic: AtomicStorageAdapter,
	db: D1Database,
	{ limit = 300 }: { limit?: number } = {}
): Promise<AdoptResult> {
	if (await db.prepare('SELECT 1 FROM openauth_atomic WHERE key = ?').bind(joinKey(ADOPTED_MARKER)).first()) {
		return { moved: 0, done: true };
	}
	const page = await kv.list({ prefix: joinKey([REFRESH_PREFIX, '']), limit });
	if (page.keys.length === 0) {
		await atomic.set(ADOPTED_MARKER, { at: Date.now() });
		adopted = true;
		return { moved: 0, done: true };
	}
	let moved = 0;
	for (const key of page.keys) {
		const value = await kv.get<{ ttl?: { refresh?: number } }>(key.name, 'json');
		if (value) {
			const expiry = key.expiration
				? new Date(key.expiration * 1000)
				: new Date(Date.now() + (value.ttl?.refresh ?? 60 * 60 * 24 * 365) * 1000);
			if (expiry.getTime() > Date.now()) {
				await atomic.add(splitKey(key.name), value, expiry);
				moved++;
			}
		}
		await kv.delete(key.name);
	}
	return { moved, done: false };
}
