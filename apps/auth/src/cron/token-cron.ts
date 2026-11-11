/**
 * @fileoverview Cron trigger handlers for token/session maintenance
 *
 * Cloudflare passes the cron *expression* (e.g. "0 * * * *") as `event.cron`, so
 * expressions configured in `triggers.crons` (wrangler.json / wrangler.qa.json)
 * are mapped to job names here.
 *
 * Note: Pending revocations removed after grace period elimination (Issue #77)
 */

import { TokenCleanupService } from '../services/token-cleanup';
import { logger } from '../logger';
import { purgeExpiredAttempts } from '../security/password-attempts';
import { purgeExpiredAppSessions } from '../services/app-sessions-cleanup';
import { purgeDeleted } from '../deletions/purge';
import { purgeRevokedInvites } from '../invites/service';
import { D1AtomicStorage } from '../storage/d1-atomic';
import { adoptLegacyRefreshTokens } from '../storage/legacy-refresh';

export type CronJobName = 'token-cleanup';

/**
 * Cron expression -> job. Keep in sync with `triggers.crons` in the wrangler configs.
 */
export const CRON_SCHEDULE: Readonly<Record<string, CronJobName>> = {
	'0 * * * *': 'token-cleanup', // hourly
};

/** Legacy job names accepted for manual invocation */
const JOB_ALIASES: Readonly<Record<string, CronJobName>> = {
	'token-cleanup': 'token-cleanup',
	'token-maintenance': 'token-cleanup',
};

/**
 * Resolve a cron expression (or legacy job name) to a job, or null if unknown.
 */
export function resolveCronJob(cron: string | undefined | null): CronJobName | null {
	if (!cron) return null;
	const key = cron.trim();
	return CRON_SCHEDULE[key] ?? JOB_ALIASES[key] ?? null;
}

/**
 * Main cron handler for token management tasks
 *
 * @param env - Cloudflare Workers environment
 * @param cron - Cron expression from ScheduledEvent.cron (or a job name)
 * @returns The job that ran, or null if the expression is not mapped
 */
export async function handleTokenCron(env: Env, cron: string): Promise<CronJobName | null> {
	const job = resolveCronJob(cron);
	if (!job) {
		logger.warn('No cron job mapped for schedule; skipping', { cron });
		return null;
	}

	const startTime = Date.now();
	logger.info('Starting cron job', { cron, job });

	try {
		switch (job) {
			case 'token-cleanup': {
				const result = await TokenCleanupService.runCleanup(env);
				logger.info('Token cleanup completed', { ...result });
				// Password attempt rows that no longer limit anything (AU-2)
				await purgeExpiredAttempts(env.AUTH_DB);
				// Expired profile/admin sessions (PF-1)
				await purgeExpiredAppSessions(env.AUTH_DB);
				// Refresh tokens still in KV from before D1 held them: moved over a batch
				// at a time; once KV has none, refresh-token keys skip KV (legacy-refresh.ts)
				try {
					const adopted = await adoptLegacyRefreshTokens(env.AUTH_STORAGE, D1AtomicStorage(env.AUTH_DB), env.AUTH_DB);
					if (adopted.moved) logger.info('Legacy KV refresh tokens moved to D1', { ...adopted });
				} catch (error) {
					logger.error('Legacy KV refresh token move failed', { error: error instanceof Error ? error.message : String(error) });
				}
				// Admin-deleted items due for permanent deletion (30 days, or asked for); never fails the job
				try {
					await purgeDeleted(env);
				} catch (error) {
					logger.error('Deleted-items cleanup failed', { error: error instanceof Error ? error.message : String(error) });
				}
				// Revoked invites past their 30 days, or queued with "Delete permanently now" (docs/USER_INVITES.md)
				try {
					const invites = await purgeRevokedInvites(env.AUTH_DB);
					if (invites.purged || invites.failed) logger.info('Invite cleanup completed', invites);
				} catch (error) {
					logger.error('Invite cleanup failed', { error: error instanceof Error ? error.message : String(error) });
				}
				break;
			}
		}

		logger.info('Cron job completed', { cron, job, duration: Date.now() - startTime });
		return job;
	} catch (error) {
		logger.error('Cron job failed', {
			cron,
			job,
			error: error instanceof Error ? error.message : String(error),
		});
		throw error;
	}
}
