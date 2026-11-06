/**
 * @fileoverview Scheduled cleanup of expired session and analytics rows in D1.
 *
 * Schema notes (verified against OpenAuth's 001_schema.sql and apps/auth/migrations):
 * - browser_sessions(id, tenant_id, created_at, last_activity, ...) — epoch **milliseconds**,
 *   no expiry column; a browser session is stale once last_activity is older than the
 *   session lifetime (7 days, same window OpenAuth's `expired_sessions` view uses).
 * - account_sessions(..., expires_at, browser_session_id FK ON DELETE CASCADE) — epoch ms.
 * - token_usage(..., created_at) — epoch ms (DEFAULT unixepoch() * 1000).
 *
 * Refresh tokens are stored in KV by the OpenAuth issuer (with KV TTLs), so the legacy
 * D1 `refresh_tokens` table is not written to and is not cleaned up here.
 *
 * D1 does not support `DELETE ... LIMIT`, so batches use `WHERE id IN (SELECT ... LIMIT ?)`.
 */

/** Rows deleted per statement */
export const CLEANUP_BATCH_SIZE = 1000;
/** Keep token usage analytics for 90 days */
export const ANALYTICS_RETENTION_DAYS = 90;
/** Browser sessions inactive for longer than this are deleted (matches 7-day session lifetime) */
export const BROWSER_SESSION_MAX_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
/** Time box for the whole cleanup run */
const MAX_EXECUTION_MS = 10_000;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface CleanupResult {
	expiredAccountSessionsDeleted: number;
	expiredBrowserSessionsDeleted: number;
	oldAnalyticsDeleted: number;
	duration: number;
	timeBoxedExit: boolean;
}

/**
 * Service for cleaning up expired sessions and old analytics
 */
export class TokenCleanupService {
	/**
	 * Main cleanup handler - called from the scheduled() handler.
	 *
	 * @param env - Cloudflare Workers environment
	 * @param now - Current time in epoch ms (injectable for tests)
	 */
	static async runCleanup(env: Env, now: number = Date.now()): Promise<CleanupResult> {
		const startTime = Date.now();

		// 1. Account sessions past their own expiry
		const expiredAccountSessionsDeleted = await this.batchDelete(
			env,
			`DELETE FROM account_sessions
			 WHERE id IN (SELECT id FROM account_sessions WHERE expires_at < ? LIMIT ?)`,
			[now],
			startTime,
		);

		// 2. Browser sessions idle past the session lifetime. Their remaining account
		//    sessions are removed explicitly first (in case FK enforcement is off),
		//    then the browser sessions themselves.
		const idleCutoff = now - BROWSER_SESSION_MAX_IDLE_MS;
		await this.batchDelete(
			env,
			`DELETE FROM account_sessions
			 WHERE id IN (
			   SELECT a.id FROM account_sessions a
			   JOIN browser_sessions b ON b.id = a.browser_session_id
			   WHERE b.last_activity < ?
			   LIMIT ?
			 )`,
			[idleCutoff],
			startTime,
		);
		const expiredBrowserSessionsDeleted = await this.batchDelete(
			env,
			`DELETE FROM browser_sessions
			 WHERE id IN (SELECT id FROM browser_sessions WHERE last_activity < ? LIMIT ?)`,
			[idleCutoff],
			startTime,
		);

		// 3. Old token usage analytics
		const analyticsCutoff = now - ANALYTICS_RETENTION_DAYS * DAY_MS;
		const oldAnalyticsDeleted = await this.batchDelete(
			env,
			`DELETE FROM token_usage
			 WHERE id IN (SELECT id FROM token_usage WHERE created_at < ? LIMIT ?)`,
			[analyticsCutoff],
			startTime,
		);

		const duration = Date.now() - startTime;
		return {
			expiredAccountSessionsDeleted,
			expiredBrowserSessionsDeleted,
			oldAnalyticsDeleted,
			duration,
			timeBoxedExit: duration >= MAX_EXECUTION_MS,
		};
	}

	/**
	 * Runs a batched DELETE until fewer than CLEANUP_BATCH_SIZE rows are affected
	 * or the time box is exhausted. The statement's last bind parameter must be the LIMIT.
	 */
	private static async batchDelete(
		env: Env,
		sql: string,
		params: unknown[],
		startTime: number,
	): Promise<number> {
		let totalDeleted = 0;
		while (Date.now() - startTime < MAX_EXECUTION_MS) {
			const result = await env.AUTH_DB.prepare(sql)
				.bind(...params, CLEANUP_BATCH_SIZE)
				.run();
			const deleted = result.meta?.changes ?? 0;
			totalDeleted += deleted;
			if (deleted < CLEANUP_BATCH_SIZE) {
				break;
			}
		}
		return totalDeleted;
	}
}
