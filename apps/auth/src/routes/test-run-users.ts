/**
 * E2E run accounts (QA and stage only).
 *
 *   POST /test/run-users/delete/:email   teardown of one run account
 *   GET  /test/run-users/stale?hours=24  run accounts older than that (the sweeper
 *                                        for crashed runs), at most STALE_LIMIT
 *
 * Every CI E2E run registers its own accounts, e2e+<run id>-<attempt>-<name>@e2e.alummahnow.net,
 * and deletes them when it ends. Registration of such an address on a deployment
 * with run-account support sets the provisioning marker (utils/e2e-sink.ts
 * markRunUser); only marked accounts are ever deleted here. A delete goes through
 * the admin delete path: soft delete (audit-logged, actor "e2e-teardown"), the
 * permanent deletion request and the purge of that one item, so nothing waits 30 days.
 *
 * Defence in depth, every one required:
 * - routeTestEndpoints: never routed when the worker runs as production, and the
 *   X-E2E-Secret header must match the E2E_CODE_SINK_SECRET binding;
 * - runUsersEnabled: the E2E_RUN_USERS flag (QA/stage wrangler vars only, never
 *   production: release check + test), a non-production ENVIRONMENT and issuer,
 *   and both secrets bound. Without it these routes do not exist (404);
 * - X-Test-Secret must equal TEST_PROMOTE_SECRET (constant-time compare);
 * - the address must match RUN_USER_EMAIL and the account must carry the marker;
 *   anything else is refused, whatever secret is sent;
 * - ADMIN_LIMITER counts the calls per client IP.
 * Secrets are never logged.
 */
import { logger } from '../logger';
import { getClientIP, RATE_LIMIT_PERIOD_SECONDS, withinRateLimit } from '../rate-limit';
import type { DeletionEnv } from '../deletions/kinds';
import { purgeItem } from '../deletions/purge';
import { DeletionError, requestPurge, softDelete, type DeletionActor } from '../deletions/service';
import { constantTimeEqual, isRunUserEmail, RUN_USER_MARKER, runUsersEnabled, type RunUsersEnv } from '../utils/e2e-sink';

export { isRunUserEmail };

export const STALE_LIMIT = 200;

export interface RunUserRoutesEnv extends RunUsersEnv {
	AUTH_DB: D1Database;
	TOKEN_REVOCATIONS?: KVNamespace;
	AUTH_THEMES?: unknown;
	ADMIN_LIMITER?: RateLimit;
}

const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

const MARKED = `json_extract(metadata, '$.${RUN_USER_MARKER}') IS NOT NULL`;

/** Routes POST /test/run-users/delete/:email and GET /test/run-users/stale; null for anything else or when disabled. */
export async function routeRunUsers(url: URL, request: Request, env: RunUserRoutesEnv): Promise<Response | null> {
	const isDelete = url.pathname.startsWith('/test/run-users/delete/') && request.method === 'POST';
	const isStale = url.pathname === '/test/run-users/stale' && request.method === 'GET';
	if (!isDelete && !isStale) return null;
	if (!(await runUsersEnabled(env))) return null;

	if (!constantTimeEqual(request.headers.get('X-Test-Secret') ?? '', env.TEST_PROMOTE_SECRET ?? '')) {
		logger.warn('Rejected /test/run-users request: wrong X-Test-Secret', { path: url.pathname });
		return json({ error: 'Unauthorized' }, 401);
	}
	const ip = getClientIP(request);
	if (!(await withinRateLimit(env.ADMIN_LIMITER, `test-run-users:${ip}`))) {
		return json({ error: 'rate_limited' }, 429, { 'Retry-After': String(RATE_LIMIT_PERIOD_SECONDS) });
	}
	if (isStale) return stale(url, env);

	let email: string;
	try {
		email = decodeURIComponent(url.pathname.slice('/test/run-users/delete/'.length)).trim().toLowerCase();
	} catch {
		return json({ error: 'bad_email' }, 400);
	}
	return remove(email, request, ip, env);
}

async function remove(email: string, request: Request, ip: string, env: RunUserRoutesEnv): Promise<Response> {
	if (!isRunUserEmail(email)) return json({ error: 'not_a_run_user', message: 'Only e2e+<run>-<attempt>-* run accounts can be deleted here' }, 400);

	const { results } = await env.AUTH_DB.prepare(`SELECT id, email, (${MARKED}) AS marked FROM users WHERE lower(email) = ?`)
		.bind(email)
		.all<{ id: string; email: string; marked: number }>();
	const rows = results ?? [];
	if (rows.some((r) => !r.marked)) {
		logger.warn('Refused to delete a run address without the provisioning marker', { email });
		return json({ error: 'not_provisioned', message: 'The account was not created by the run provisioning path' }, 403);
	}

	const actor: DeletionActor = {
		userId: 'e2e-teardown',
		email: null,
		ip,
		userAgent: request.headers.get('User-Agent'),
		requestId: request.headers.get('X-Request-Id'),
	};
	const deletionEnv = env as unknown as DeletionEnv;
	let purged = 0;
	try {
		for (const user of rows) {
			try {
				await softDelete(deletionEnv, 'user', user.id, actor, { reason: 'E2E run teardown' });
			} catch (error) {
				// A retry after a failed purge finds the account already soft-deleted
				if (!(error instanceof DeletionError && (error.code === 'already_deleted' || error.code === 'user_not_found'))) throw error;
			}
			try {
				await requestPurge(deletionEnv, 'user', user.id, actor, user.email);
			} catch (error) {
				if (!(error instanceof DeletionError && error.code === 'not_deleted')) throw error;
			}
			if (await purgeItem(deletionEnv, 'user', user.id)) purged++;
		}
		// The invite link the E2E sink kept for the address (invites/routes.ts), if it was invited
		await env.AUTH_STORAGE?.delete(`test:invite:${email}`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logger.error('E2E run account delete failed', { email, error: message });
		return json({ error: 'delete_failed', message }, error instanceof DeletionError ? error.status : 500);
	}
	logger.info('E2E run account deleted', { email, accounts: rows.length, purged });
	return json({ success: true, found: rows.length, purged }, 200);
}

async function stale(url: URL, env: RunUserRoutesEnv): Promise<Response> {
	const hours = Number(url.searchParams.get('hours') ?? '24');
	if (!Number.isFinite(hours) || hours < 1) return json({ error: 'hours must be a number >= 1' }, 400);
	const before = Date.now() - hours * 60 * 60 * 1000;
	const { results } = await env.AUTH_DB.prepare(
		`SELECT email FROM users WHERE email LIKE 'e2e+%@e2e.alummahnow.net' AND ${MARKED} AND created_at < ? ORDER BY created_at LIMIT ?`
	)
		.bind(before, STALE_LIMIT)
		.all<{ email: string }>();
	const emails = (results ?? []).map((r) => r.email.toLowerCase()).filter(isRunUserEmail);
	return json({ emails, limit: STALE_LIMIT }, 200);
}
