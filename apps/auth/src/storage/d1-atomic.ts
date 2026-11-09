/**
 * The OpenAuth issuer's atomic store on D1 (`StorageAdapter.atomic`).
 *
 * KV has no compare-and-set and edge-caches reads for about 60 s, so it cannot
 * hold single-use or rotating credentials: two isolates or PoPs both see an
 * authorization code before either deletes it. D1 has one strongly
 * consistent writer, and every operation here is a single conditional
 * statement, so each one is atomic:
 *
 * - add:     INSERT … ON CONFLICT DO UPDATE … WHERE <existing row expired>
 * - replace: UPDATE … WHERE key = ? AND value = <expected JSON> AND live
 * - take:    DELETE … WHERE key = ? AND live RETURNING value
 *
 * Table: openauth_atomic (migrations/0021_openauth_atomic.sql). Expired rows
 * are invisible to every operation and deleted by the token-cleanup cron.
 */
import { joinKey, type AtomicStorageAdapter } from '@al-ummah-now/openauth/storage/storage';

const TABLE = 'openauth_atomic';
const LIVE = '(expires_at IS NULL OR expires_at > ?)';

const ms = (expiry?: Date) => (expiry ? expiry.getTime() : null);

export function D1AtomicStorage(db: D1Database): AtomicStorageAdapter {
	return {
		async get(key) {
			const row = await db
				.prepare(`SELECT value FROM ${TABLE} WHERE key = ? AND ${LIVE}`)
				.bind(joinKey(key), Date.now())
				.first<{ value: string }>();
			return row ? JSON.parse(row.value) : undefined;
		},

		async set(key, value, expiry) {
			await db
				.prepare(
					`INSERT INTO ${TABLE} (key, value, expires_at) VALUES (?, ?, ?)
					 ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`,
				)
				.bind(joinKey(key), JSON.stringify(value), ms(expiry))
				.run();
		},

		async add(key, value, expiry) {
			// Inserts, or takes over a row that has expired; a live row wins
			const result = await db
				.prepare(
					`INSERT INTO ${TABLE} (key, value, expires_at) VALUES (?, ?, ?)
					 ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at
					 WHERE ${TABLE}.expires_at IS NOT NULL AND ${TABLE}.expires_at <= ?`,
				)
				.bind(joinKey(key), JSON.stringify(value), ms(expiry), Date.now())
				.run();
			return (result.meta?.changes ?? 0) === 1;
		},

		async replace(key, expected, value, expiry) {
			const result = await db
				.prepare(`UPDATE ${TABLE} SET value = ?, expires_at = ? WHERE key = ? AND value = ? AND ${LIVE}`)
				.bind(JSON.stringify(value), ms(expiry), joinKey(key), JSON.stringify(expected), Date.now())
				.run();
			return (result.meta?.changes ?? 0) === 1;
		},

		async take(key) {
			const row = await db
				.prepare(`DELETE FROM ${TABLE} WHERE key = ? AND ${LIVE} RETURNING value`)
				.bind(joinKey(key), Date.now())
				.first<{ value: string }>();
			return row ? JSON.parse(row.value) : undefined;
		},

		async remove(key) {
			await db.prepare(`DELETE FROM ${TABLE} WHERE key = ?`).bind(joinKey(key)).run();
		},
	};
}
