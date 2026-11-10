/**
 * Hourly purge of expired first-party app sessions (profile, admin) in D1
 * (`app_sessions`, migration 0021). A logged-out session keeps its row, as
 * the record that it is logged out, until it would have expired anyway.
 */

/** Rows removed per statement, so one run never holds the database for long. */
const PURGE_BATCH = 5000;

export async function purgeExpiredAppSessions(db: D1Database, nowMs = Date.now()): Promise<number> {
	const result = await db
		.prepare(
			`DELETE FROM app_sessions WHERE id IN (SELECT id FROM app_sessions WHERE expires_at <= ?1 LIMIT ${PURGE_BATCH})`
		)
		.bind(nowMs)
		.run();
	return result.meta.changes ?? 0;
}
