/**
 * @fileoverview Cron trigger handlers for token management
 *
 * Handles scheduled tasks:
 * - Clean up expired tokens
 * - Clean up old analytics
 * - Archive old audit events to R2
 *
 * Note: Pending revocations removed after grace period elimination (Issue #77)
 */

import { TokenCleanupService } from '../services/token-cleanup';
import { archiveAuditEvents, archiveTokenUsageEvents } from '../services/audit-archival';
import { logger } from '../logger';

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
	logger.info('Starting token cron job', { cronName });

	try {
		// Run cleanup
		if (cronName === 'token-cleanup' || cronName === 'token-maintenance') {
			const cleanupResult = await TokenCleanupService.runCleanup(env);
			logger.info('Token cleanup completed', {
				expiredTokensDeleted: cleanupResult.expiredTokensDeleted,
				oldAnalyticsDeleted: cleanupResult.oldAnalyticsDeleted,
				duration: cleanupResult.duration,
			});
		}

		// Run audit archival (archive events older than 30 days to R2)
		if (cronName === 'audit-archival' || cronName === 'token-maintenance') {
			if (env.AUDIT_ARCHIVE) {
				// Archive audit_events table
				const auditResult = await archiveAuditEvents(env.AUTH_DB, env.AUDIT_ARCHIVE, {
					retentionDays: 30,
					batchSize: 5000,
				});
				logger.info('Audit events archival completed', {
					eventsArchived: auditResult.eventsArchived,
					eventsDeleted: auditResult.eventsDeleted,
					filesCreated: auditResult.filesCreated,
					duration: auditResult.duration,
				});

				// Archive token_usage table
				const tokenUsageResult = await archiveTokenUsageEvents(env.AUTH_DB, env.AUDIT_ARCHIVE, {
					retentionDays: 30,
					batchSize: 5000,
				});
				logger.info('Token usage archival completed', {
					eventsArchived: tokenUsageResult.eventsArchived,
					eventsDeleted: tokenUsageResult.eventsDeleted,
					filesCreated: tokenUsageResult.filesCreated,
					duration: tokenUsageResult.duration,
				});
			} else {
				logger.warn('AUDIT_ARCHIVE R2 bucket not configured, skipping archival');
			}
		}

		const duration = Date.now() - startTime;
		logger.info('Token cron job completed', { cronName, duration });
	} catch (error) {
		logger.error('Token cron job failed', { cronName, error });
		throw error;
	}
}
