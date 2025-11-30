/**
 * @fileoverview Cron trigger handlers for token management
 *
 * Handles scheduled tasks:
 * - Clean up expired tokens
 * - Clean up old analytics
 *
 * Note: Pending revocations removed after grace period elimination (Issue #77)
 */

import { TokenCleanupService } from '../services/token-cleanup';

/**
 * Main cron handler for token management tasks
 *
 * This function should be called by Cloudflare Cron Triggers
 * Schedule recommendations:
 * - Every hour: Clean up expired tokens and old analytics
 *
 * @param env - Cloudflare Workers environment
 * @param cronName - Name of the cron trigger
 */
export async function handleTokenCron(env: Env, cronName: string): Promise<void> {
	const startTime = Date.now();
	console.info(`Starting token cron job: ${cronName}`);

	try {
		// Run cleanup
		if (cronName === 'token-cleanup' || cronName === 'token-maintenance') {
			const cleanupResult = await TokenCleanupService.runCleanup(env);
			console.info('Token cleanup completed', {
				expiredTokensDeleted: cleanupResult.expiredTokensDeleted,
				oldAnalyticsDeleted: cleanupResult.oldAnalyticsDeleted,
				duration: cleanupResult.duration,
			});
		}

		const duration = Date.now() - startTime;
		console.info(`Token cron job completed: ${cronName} (${duration}ms)`);
	} catch (error) {
		console.error(`Token cron job failed: ${cronName}`, error);
		throw error;
	}
}
