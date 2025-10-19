/**
 * @fileoverview Token cleanup service for removing expired tokens
 *
 * This service implements:
 * - Periodic cleanup of expired refresh tokens
 * - Cleanup of old token usage analytics
 * - Designed to run as a Cloudflare Cron Trigger
 */

/**
 * Configuration constants for cleanup
 */
const CLEANUP_BATCH_SIZE = 100; // Process tokens in batches
const ANALYTICS_RETENTION_DAYS = 90; // Keep analytics for 90 days

/**
 * Service for cleaning up expired and old tokens
 */
export class TokenCleanupService {
	/**
	 * Main cleanup handler - designed to be called from a Cron Trigger
	 *
	 * @param env - Cloudflare Workers environment
	 * @returns Summary of cleanup operations
	 */
	static async runCleanup(env: Env): Promise<{
		expiredTokensDeleted: number;
		oldAnalyticsDeleted: number;
		duration: number;
	}> {
		const startTime = Date.now();

		// Clean up expired tokens
		const expiredTokensDeleted = await this.cleanupExpiredTokens(env);

		// Clean up old analytics
		const oldAnalyticsDeleted = await this.cleanupOldAnalytics(env);

		const duration = Date.now() - startTime;

		console.log('Token cleanup completed', {
			expiredTokensDeleted,
			oldAnalyticsDeleted,
			duration,
		});

		return {
			expiredTokensDeleted,
			oldAnalyticsDeleted,
			duration,
		};
	}

	/**
	 * Removes expired refresh tokens from the database
	 *
	 * @param env - Cloudflare Workers environment
	 * @returns Number of tokens deleted
	 */
	private static async cleanupExpiredTokens(env: Env): Promise<number> {
		const now = Math.floor(Date.now() / 1000);
		let totalDeleted = 0;

		// Find expired tokens in batches
		while (true) {
			// Get a batch of expired token IDs
			const expiredTokens = await env.AUTH_DB.prepare(
				`SELECT id FROM refresh_tokens
         WHERE expires_at < ?
         LIMIT ?`
			)
				.bind(now, CLEANUP_BATCH_SIZE)
				.all<{ id: string }>();

			if (!expiredTokens.results || expiredTokens.results.length === 0) {
				break;
			}

			const tokenIds = expiredTokens.results.map((t) => t.id);

			// Delete the batch
			const placeholders = tokenIds.map(() => '?').join(',');
			const result = await env.AUTH_DB.prepare(
				`DELETE FROM refresh_tokens WHERE id IN (${placeholders})`
			)
				.bind(...tokenIds)
				.run();

			const deleted = result.meta?.changes ?? 0;
			totalDeleted += deleted;

			// If we deleted fewer tokens than the batch size, we're done
			if (deleted < CLEANUP_BATCH_SIZE) {
				break;
			}

			// No delay needed - D1 can handle batch operations
		}

		return totalDeleted;
	}

	/**
	 * Removes old token usage analytics from the database
	 *
	 * @param env - Cloudflare Workers environment
	 * @returns Number of analytics records deleted
	 */
	private static async cleanupOldAnalytics(env: Env): Promise<number> {
		const cutoffTime = Math.floor(Date.now() / 1000) - ANALYTICS_RETENTION_DAYS * 24 * 60 * 60;
		let totalDeleted = 0;

		// Delete old analytics in batches
		while (true) {
			const result = await env.AUTH_DB.prepare(
				`DELETE FROM token_usage
         WHERE id IN (
           SELECT id FROM token_usage
           WHERE timestamp < ?
           LIMIT ?
         )`
			)
				.bind(cutoffTime, CLEANUP_BATCH_SIZE)
				.run();

			const deleted = result.meta?.changes ?? 0;
			totalDeleted += deleted;

			// If we deleted fewer records than the batch size, we're done
			if (deleted < CLEANUP_BATCH_SIZE) {
				break;
			}

			// No delay needed - D1 can handle batch operations
		}

		return totalDeleted;
	}

	/**
	 * Manually revokes all tokens for a specific user
	 * Useful for account security events (password reset, logout all devices, etc.)
	 *
	 * @param env - Cloudflare Workers environment
	 * @param userId - The user ID whose tokens should be revoked
	 * @param reason - The reason for revocation
	 * @returns Number of tokens revoked
	 */
	static async revokeAllUserTokens(env: Env, userId: string, reason: string = 'user_security_action'): Promise<number> {
		const now = Math.floor(Date.now() / 1000);

		const result = await env.AUTH_DB.prepare(
			`UPDATE refresh_tokens
       SET revoked = 1, revoked_at = ?, revoked_reason = ?
       WHERE user_id = ? AND revoked = 0`
		)
			.bind(now, reason, userId)
			.run();

		return result.meta?.changes ?? 0;
	}

	/**
	 * Gets statistics about refresh tokens
	 *
	 * @param env - Cloudflare Workers environment
	 * @returns Token statistics
	 */
	static async getTokenStats(env: Env): Promise<{
		totalActive: number;
		totalExpired: number;
		totalRevoked: number;
		averageRotationCount: number;
	}> {
		const now = Math.floor(Date.now() / 1000);

		interface TokenStats {
			totalActive: number;
			totalExpired: number;
			totalRevoked: number;
			averageRotationCount: number;
		}

		const stats = await env.AUTH_DB.prepare(
			`SELECT
         COUNT(CASE WHEN revoked = 0 AND expires_at > ? THEN 1 END) as totalActive,
         COUNT(CASE WHEN expires_at <= ? THEN 1 END) as totalExpired,
         COUNT(CASE WHEN revoked = 1 THEN 1 END) as totalRevoked,
         AVG(rotation_count) as averageRotationCount
       FROM refresh_tokens`
		)
			.bind(now, now)
			.first<TokenStats>();

		return {
			totalActive: stats?.totalActive ?? 0,
			totalExpired: stats?.totalExpired ?? 0,
			totalRevoked: stats?.totalRevoked ?? 0,
			averageRotationCount: stats?.averageRotationCount ?? 0,
		};
	}
}
