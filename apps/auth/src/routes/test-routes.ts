/**
 * @fileoverview Test endpoints for E2E testing (development, QA and stage only)
 *
 * Disabled in production. Every route also requires the X-E2E-Secret header
 * (E2E_CODE_SINK_SECRET binding, see utils/e2e-sink.ts) and answers 404 without it.
 * Routes:
 * - /test/email/:email - Retrieve verification code sent to email
 * - /test/promote/:email - Promote user to admin role
 * - /test/tokens/:email - Get token info for a user
 * - /test/run-users/delete/:email, /test/run-users/stale - E2E run accounts (test-run-users.ts)
 * - POST /test/report-error - a marked test error through the reporter (admin Errors page, #341)
 * - GET /test/system-accounts - the system accounts and every role row they hold (must be none)
 */

import { logger } from '../logger';
import { isAuthorizedTestRequest, sinkKey } from '../utils/e2e-sink';
import { routeRunUsers, type RunUserRoutesEnv } from './test-run-users';
import { buildErrorEvent, sendEvents, type ErrorReportEnv } from '../errors/report';
import { SYSTEM_USER_IDS_SQL } from '../security/system-accounts';

interface TestRoutesEnv extends Partial<Omit<RunUserRoutesEnv, 'AUTH_DB' | 'AUTH_STORAGE' | 'TEST_PROMOTE_SECRET' | 'ENVIRONMENT' | 'OPENAUTH_ISSUER' | 'E2E_CODE_SINK_SECRET'>> {
	AUTH_STORAGE: KVNamespace;
	AUTH_DB: D1Database;
	TEST_PROMOTE_SECRET?: string;
	ENVIRONMENT?: string;
	OPENAUTH_ISSUER?: string;
	E2E_CODE_SINK_SECRET?: unknown;
}

interface TestRouteContext {
	waitUntil: (promise: Promise<unknown>) => void;
}

/**
 * Handle test email retrieval endpoint
 * GET /test/email/:email[?consume=1]
 *
 * Retrieves the verification code that was sent to an email address.
 * Used by E2E tests to complete the login flow.
 */
export async function handleTestEmailGet(
	email: string,
	env: TestRoutesEnv,
	ctx: TestRouteContext,
	consume = false
): Promise<Response> {
	logger.debug('Test endpoint: retrieving email code', { email });

	try {
		const stored = await env.AUTH_STORAGE.get(sinkKey(email));

		if (!stored) {
			ctx.waitUntil(logger.finalizeRequest());
			return new Response(JSON.stringify({ error: 'No email found for this address' }), {
				status: 404,
				headers: { 'Content-Type': 'application/json' },
			});
		}

		const data = JSON.parse(stored);
		// consume=1: delete after reading, so a later read only sees a newer code
		if (consume) await env.AUTH_STORAGE.delete(sinkKey(email));
		ctx.waitUntil(logger.finalizeRequest());
		return new Response(JSON.stringify({ code: data.code, emailId: data.emailId }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	} catch (error) {
		logger.error('Error retrieving test email', { email, error });
		ctx.waitUntil(logger.finalizeRequest());
		return new Response(JSON.stringify({ error: 'Internal server error' }), {
			status: 500,
			headers: { 'Content-Type': 'application/json' },
		});
	}
}

/**
 * Handle test promote endpoint
 * POST /test/promote/:email
 *
 * Promotes a user to admin role. Requires TEST_PROMOTE_SECRET header.
 * Used by E2E tests to set up admin users.
 */
export async function handleTestPromotePost(
	email: string,
	request: Request,
	env: TestRoutesEnv,
	ctx: TestRouteContext
): Promise<Response> {
	logger.debug('Test endpoint: promoting user to admin', { email });

	// Additional security: require TEST_PROMOTE_SECRET header
	const providedSecret = request.headers.get('X-Test-Secret');
	const expectedSecret = env.TEST_PROMOTE_SECRET;

	if (!expectedSecret) {
		logger.error('TEST_PROMOTE_SECRET not configured');
		ctx.waitUntil(logger.finalizeRequest());
		return new Response(JSON.stringify({ error: 'Test endpoint not properly configured' }), {
			status: 500,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	if (providedSecret !== expectedSecret) {
		logger.warn('Invalid test secret provided for /test/promote', { email });
		ctx.waitUntil(logger.finalizeRequest());
		return new Response(JSON.stringify({ error: 'Unauthorized' }), {
			status: 401,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	try {
		// First get the user
		const user = await env.AUTH_DB.prepare(`SELECT id, email FROM users WHERE email = ?`)
			.bind(email)
			.first<{ id: string; email: string }>();

		if (!user) {
			ctx.waitUntil(logger.finalizeRequest());
			return new Response(JSON.stringify({ error: 'User not found' }), {
				status: 404,
				headers: { 'Content-Type': 'application/json' },
			});
		}

		// Assign admin role via RBAC (using OpenAuth's rbac_user_roles directly for upsert)
		// Note: OpenAuth seeds role_admin (not role_admin_default) in 002_seed.sql
		await env.AUTH_DB.prepare(
			`INSERT INTO rbac_user_roles (user_id, role_id, tenant_id, assigned_at, assigned_by)
       VALUES (?, 'role_admin', 'default', ?, 'system')
       ON CONFLICT(user_id, role_id, tenant_id) DO UPDATE SET assigned_by = 'system'`
		)
			.bind(user.id, Date.now())
			.run();

		logger.info('User promoted to admin (E2E test)', { userId: user.id, email: user.email });
		ctx.waitUntil(logger.finalizeRequest());
		return new Response(JSON.stringify({ success: true, user: { ...user, role: 'admin' } }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	} catch (error) {
		logger.error('Error promoting user to admin', { email, error });
		ctx.waitUntil(logger.finalizeRequest());
		return new Response(JSON.stringify({ error: 'Internal server error' }), {
			status: 500,
			headers: { 'Content-Type': 'application/json' },
		});
	}
}

/**
 * Handle test tokens endpoint
 * POST /test/tokens/:email
 *
 * Retrieves token info for a user. Requires TEST_PROMOTE_SECRET header.
 * Used by E2E tests to verify token state.
 */
export async function handleTestTokensPost(
	email: string,
	request: Request,
	env: TestRoutesEnv,
	ctx: TestRouteContext
): Promise<Response> {
	logger.debug('Test endpoint: getting tokens for user', { email });

	// Require TEST_PROMOTE_SECRET header for security
	const providedSecret = request.headers.get('X-Test-Secret');
	const expectedSecret = env.TEST_PROMOTE_SECRET;

	if (!expectedSecret) {
		logger.error('TEST_PROMOTE_SECRET not configured');
		ctx.waitUntil(logger.finalizeRequest());
		return new Response(JSON.stringify({ error: 'Test endpoint not properly configured' }), {
			status: 500,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	if (providedSecret !== expectedSecret) {
		logger.warn('Invalid test secret provided for /test/tokens', { email });
		ctx.waitUntil(logger.finalizeRequest());
		return new Response(JSON.stringify({ error: 'Unauthorized' }), {
			status: 401,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	try {
		// Get the user from database
		const user = await env.AUTH_DB.prepare(`SELECT id, email FROM users WHERE email = ?`)
			.bind(email)
			.first<{ id: string; email: string }>();

		if (!user) {
			ctx.waitUntil(logger.finalizeRequest());
			return new Response(JSON.stringify({ error: 'User not found' }), {
				status: 404,
				headers: { 'Content-Type': 'application/json' },
			});
		}

		// Get the most recent active refresh token for this user
		const refreshTokenRecord = await env.AUTH_DB.prepare(
			`SELECT id, token_hash, client_id, scope, expires_at, issued_at
       FROM refresh_tokens
       WHERE user_id = ?
       AND revoked = 0
       AND expires_at > ?
       ORDER BY issued_at DESC
       LIMIT 1`
		)
			.bind(user.id, Math.floor(Date.now() / 1000))
			.first<{
				id: string;
				token_hash: string;
				client_id: string;
				scope: string;
				expires_at: number;
				issued_at: number;
			}>();

		if (!refreshTokenRecord) {
			ctx.waitUntil(logger.finalizeRequest());
			return new Response(
				JSON.stringify({
					error: 'No active refresh token found',
					hint: 'User needs to login first to create a refresh token',
				}),
				{
					status: 404,
					headers: { 'Content-Type': 'application/json' },
				}
			);
		}

		// Note: We can't return the actual refresh token since we only store the hash
		// Instead, return the token hash which can be used for introspection/revocation testing
		logger.info('Token info retrieved for E2E test', { userId: user.id, email: user.email });
		ctx.waitUntil(logger.finalizeRequest());
		return new Response(
			JSON.stringify({
				success: true,
				user: { id: user.id, email: user.email },
				token_info: {
					id: refreshTokenRecord.id,
					token_hash: refreshTokenRecord.token_hash,
					client_id: refreshTokenRecord.client_id,
					scope: refreshTokenRecord.scope,
					expires_at: refreshTokenRecord.expires_at,
					issued_at: refreshTokenRecord.issued_at,
				},
				note: 'Refresh token hash returned - actual token not available (only hash stored)',
			}),
			{
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}
		);
	} catch (error) {
		logger.error('Error getting tokens', { email, error });
		ctx.waitUntil(logger.finalizeRequest());
		return new Response(JSON.stringify({ error: 'Internal server error' }), {
			status: 500,
			headers: { 'Content-Type': 'application/json' },
		});
	}
}

/**
 * Handle test debug KV keys endpoint
 * GET /test/debug/kv
 *
 * Lists all keys in KV storage for debugging.
 * Used to find the key name OpenAuth uses for storing JWKS.
 */
export async function handleTestDebugKV(
	env: TestRoutesEnv,
	ctx: TestRouteContext
): Promise<Response> {
	logger.debug('Test endpoint: listing KV keys');

	try {
		// List all keys (with prefix '' to get all)
		const keysList = await env.AUTH_STORAGE.list();

		// Try to get specific key values for debugging
		const keysWithValues: Array<{ name: string; valuePreview: string }> = [];
		for (const key of keysList.keys.slice(0, 20)) {
			// Limit to 20 keys
			try {
				const value = await env.AUTH_STORAGE.get(key.name);
				keysWithValues.push({
					name: key.name,
					valuePreview: value ? value.substring(0, 200) + (value.length > 200 ? '...' : '') : 'null',
				});
			} catch {
				keysWithValues.push({ name: key.name, valuePreview: 'error reading' });
			}
		}

		ctx.waitUntil(logger.finalizeRequest());
		return new Response(
			JSON.stringify({
				total: keysList.keys.length,
				listComplete: keysList.list_complete,
				keys: keysList.keys.map((k) => k.name),
				keysWithValues,
			}),
			{
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}
		);
	} catch (error) {
		logger.error('Error listing KV keys', { error });
		ctx.waitUntil(logger.finalizeRequest());
		return new Response(
			JSON.stringify({
				error: 'Internal server error',
				details: error instanceof Error ? error.message : String(error),
			}),
			{
				status: 500,
				headers: { 'Content-Type': 'application/json' },
			}
		);
	}
}

/**
 * Handle test debug roles endpoint
 * GET /test/debug/roles
 *
 * Retrieves all roles directly from the database for debugging.
 * Used by E2E tests to verify roles are seeded correctly.
 */
export async function handleTestDebugRoles(
	env: TestRoutesEnv,
	ctx: TestRouteContext
): Promise<Response> {
	logger.debug('Test endpoint: getting debug roles info');

	try {
		// Query roles directly from the database
		const rolesResult = await env.AUTH_DB.prepare(
			`SELECT id, name, tenant_id, description, is_system_role, created_at, updated_at
			 FROM rbac_roles
			 ORDER BY created_at DESC`
		).all();

		// Also get table schema info
		const tableInfo = await env.AUTH_DB.prepare(
			`SELECT sql FROM sqlite_master WHERE type='table' AND name='rbac_roles'`
		).first<{ sql: string }>();

		// Get distinct tenant_ids
		const tenantIds = await env.AUTH_DB.prepare(
			`SELECT DISTINCT tenant_id FROM rbac_roles`
		).all();

		ctx.waitUntil(logger.finalizeRequest());
		return new Response(
			JSON.stringify({
				total: rolesResult.results?.length || 0,
				roles: rolesResult.results || [],
				distinctTenantIds: tenantIds.results?.map((r: Record<string, unknown>) => r.tenant_id) || [],
				tableSchema: tableInfo?.sql || 'not found',
			}),
			{
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}
		);
	} catch (error) {
		logger.error('Error getting debug roles', { error });
		ctx.waitUntil(logger.finalizeRequest());
		return new Response(
			JSON.stringify({
				error: 'Internal server error',
				details: error instanceof Error ? error.message : String(error),
			}),
			{
				status: 500,
				headers: { 'Content-Type': 'application/json' },
			}
		);
	}
}

/**
 * Handle test debug clients endpoint
 * GET /test/debug/clients/:clientId?
 *
 * Retrieves OAuth client info for debugging. If clientId provided, gets specific client.
 * Otherwise returns all clients.
 * Used by E2E tests to verify client tenant_id configuration.
 */
export async function handleTestDebugClients(
	env: TestRoutesEnv,
	ctx: TestRouteContext,
	clientId?: string
): Promise<Response> {
	logger.debug('Test endpoint: getting debug clients info', { clientId });

	try {
		if (clientId) {
			// Get specific client
			const client = await env.AUTH_DB.prepare(
				`SELECT id, tenant_id, name, grant_types, scopes, redirect_uris, metadata, enabled, created_at, updated_at
				 FROM oauth_clients
				 WHERE id = ?`
			)
				.bind(clientId)
				.first();

			if (!client) {
				ctx.waitUntil(logger.finalizeRequest());
				return new Response(JSON.stringify({ error: 'Client not found' }), {
					status: 404,
					headers: { 'Content-Type': 'application/json' },
				});
			}

			ctx.waitUntil(logger.finalizeRequest());
			return new Response(
				JSON.stringify({
					client,
					// Parse JSON fields for easier reading
					parsed: {
						grant_types: JSON.parse((client as Record<string, unknown>).grant_types as string || '[]'),
						scopes: JSON.parse((client as Record<string, unknown>).scopes as string || '[]'),
						redirect_uris: JSON.parse((client as Record<string, unknown>).redirect_uris as string || '[]'),
						metadata: JSON.parse((client as Record<string, unknown>).metadata as string || '{}'),
					},
				}),
				{
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				}
			);
		}

		// Get all clients (without secrets)
		const clientsResult = await env.AUTH_DB.prepare(
			`SELECT id, tenant_id, name, grant_types, scopes, enabled, created_at, updated_at
			 FROM oauth_clients
			 ORDER BY created_at DESC`
		).all();

		// Get distinct tenant_ids
		const tenantIds = await env.AUTH_DB.prepare(
			`SELECT DISTINCT tenant_id FROM oauth_clients`
		).all();

		ctx.waitUntil(logger.finalizeRequest());
		return new Response(
			JSON.stringify({
				total: clientsResult.results?.length || 0,
				clients: clientsResult.results || [],
				distinctTenantIds: tenantIds.results?.map((r: Record<string, unknown>) => r.tenant_id) || [],
			}),
			{
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}
		);
	} catch (error) {
		logger.error('Error getting debug clients', { error });
		ctx.waitUntil(logger.finalizeRequest());
		return new Response(
			JSON.stringify({
				error: 'Internal server error',
				details: error instanceof Error ? error.message : String(error),
			}),
			{
				status: 500,
				headers: { 'Content-Type': 'application/json' },
			}
		);
	}
}

/**
 * Route test endpoints
 *
 * @param request - The incoming request
 * @param env - Environment bindings
 * @param ctx - Execution context
 * @param isProduction - Whether running in production (test routes disabled)
 * @returns Response if handled, null if not a test route
 */
export async function routeTestEndpoints(
	request: Request,
	env: TestRoutesEnv,
	ctx: TestRouteContext,
	isProduction: boolean
): Promise<Response | null> {
	const url = new URL(request.url);

	// Test endpoints disabled in production
	if (isProduction || !url.pathname.startsWith('/test/')) {
		return null;
	}

	if (!(await isAuthorizedTestRequest(env, request))) {
		logger.warn('Rejected unauthorized test route request', { path: url.pathname });
		ctx.waitUntil(logger.finalizeRequest());
		return new Response('Not Found', { status: 404 });
	}

	// GET /test/email/:email
	if (url.pathname.startsWith('/test/email/') && request.method === 'GET') {
		const email = decodeURIComponent(url.pathname.split('/test/email/')[1]);
		return handleTestEmailGet(email, env, ctx, url.searchParams.get('consume') === '1');
	}

	// POST /test/promote/:email
	if (url.pathname.startsWith('/test/promote/') && request.method === 'POST') {
		const email = decodeURIComponent(url.pathname.split('/test/promote/')[1]);
		return handleTestPromotePost(email, request, env, ctx);
	}

	// POST /test/tokens/:email
	if (url.pathname.startsWith('/test/tokens/') && request.method === 'POST') {
		const email = decodeURIComponent(url.pathname.split('/test/tokens/')[1]);
		return handleTestTokensPost(email, request, env, ctx);
	}

	// POST /test/run-users/delete/:email, GET /test/run-users/stale (only with run-account support)
	const runUsers = await routeRunUsers(url, request, env as RunUserRoutesEnv);
	if (runUsers) {
		ctx.waitUntil(logger.finalizeRequest());
		return runUsers;
	}

	// GET /test/system-accounts: E2E proof on the live QA/stage D1 that no system account
	// holds a role (security/system-accounts.ts). Primary-key reads only.
	if (url.pathname === '/test/system-accounts' && request.method === 'GET') {
		const users = await env.AUTH_DB.prepare(`SELECT id, status, json_extract(metadata, '$.type') AS type FROM users WHERE id IN (${SYSTEM_USER_IDS_SQL})`).all();
		const roles = await env.AUTH_DB.prepare(`SELECT user_id, role_id FROM rbac_user_roles WHERE user_id IN (${SYSTEM_USER_IDS_SQL})`).all();
		ctx.waitUntil(logger.finalizeRequest());
		return new Response(JSON.stringify({ accounts: users.results ?? [], roles: roles.results ?? [] }), {
			status: 200,
			headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
		});
	}

	// POST /test/report-error: a marked test error through the real reporter (#341): proves Auth's
	// reports reach the admin Errors page in this env. Never alerts (test), gone after a day.
	if (url.pathname === '/test/report-error' && request.method === 'POST') {
		const event = buildErrorEvent(new Error(`Auth error-reporting probe ${new Date().toISOString()}`), { route: '/test/report-error', method: 'POST', test: true }, env as ErrorReportEnv);
		const ingest = await sendEvents(env as ErrorReportEnv, [event]);
		ctx.waitUntil(logger.finalizeRequest());
		return new Response(JSON.stringify({ reference: event.ref, ingest }), {
			status: ingest === 202 ? 200 : 502,
			headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
		});
	}

	// GET /test/debug/roles - Debug endpoint for roles
	if (url.pathname === '/test/debug/roles' && request.method === 'GET') {
		return handleTestDebugRoles(env, ctx);
	}

	// GET /test/debug/clients/:clientId? - Debug endpoint for OAuth clients
	if (url.pathname.startsWith('/test/debug/clients') && request.method === 'GET') {
		const clientId = url.pathname.replace('/test/debug/clients', '').replace(/^\//, '') || undefined;
		return handleTestDebugClients(env, ctx, clientId);
	}

	// GET /test/debug/kv - Debug endpoint for KV storage keys
	if (url.pathname === '/test/debug/kv' && request.method === 'GET') {
		return handleTestDebugKV(env, ctx);
	}

	return null;
}
