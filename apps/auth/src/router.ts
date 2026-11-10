/**
 * @fileoverview Main router for the auth app
 *
 * Handles all pathname-based routing logic, delegating to appropriate handlers.
 */

import { Hono } from 'hono';
import { adminThemeRoutes, handlePublicThemeList, handleThemeAsset, handleThemeResolve } from './themes/routes';
import { logger } from './logger';
import { isAllowedOrigin } from './utils/cors';
import { addSecurityHeaders } from './utils/security-headers';
import { routeTestEndpoints } from './routes/test-routes';
import { handleLogout } from './handlers/logout-handler';
import { handleCallback } from './handlers/callback-handler';
import {
	handleSettingsSessions,
	handleAccountSwitcher,
	handleAdminSessionsDashboard,
} from './handlers/session-ui-handlers';
import { handleSelectAccountGet, handleSelectAccountPost } from './routes/select-account';
import { RATE_LIMIT_PERIOD_SECONDS, getClientIP, withinRateLimit } from './rate-limit';
import { getAuditEmitter } from './audit-emitter';
import { createRateLimitExceededEvent } from './audit-events';
import { trackEvent } from './utils/analytics';
import { readTokenRequestFields, tokenRateLimitBuckets } from './utils/token-rate-limit-subject';
import { handleAccountExport, handleDeleteAccount, handleSignOutAll } from './routes/account-routes';
import { AdminEnterpriseRoutes } from './admin-enterprise-routes';
import { AdminTenantRoutes } from './admin-tenant-routes';
import { routeAdminDLQ } from './admin-dlq-routes';
import adminSessionRoutes from './routes/admin-session-routes';
import adminStatsRoutes from './routes/admin-stats-routes';
import { BrowserSessionService } from './services/browser-session.service';
import { parseSessionCookie } from './utils/session-cookie';
import { requireAdmin } from './middleware/admin-auth';
import { verifyAdminAuth } from './auth-middleware';
import { routeModerationClient } from './moderation/client-routes';
import { moderationAdminRoutes } from './moderation/admin-routes';
import { deletionAdminRoutes } from './deletions/routes';
import { routeInvitePage, routeInviteProvisioning } from './invites/routes';
import { openauthThemeFor } from '../../../packages/ui/src/auth-theme/compile.ts';
import { compileBuiltin } from '../../../packages/ui/src/auth-theme/builtin.ts';
import { BUILTIN_DEFAULT_THEME } from '../../../packages/ui/src/auth-theme/resolve.ts';

const methodNotAllowed = (allow: string) =>
	new Response(JSON.stringify({ error: 'method_not_allowed' }), { status: 405, headers: { Allow: allow, 'Content-Type': 'application/json' } });

/**
 * Router context containing all dependencies
 */
export interface RouterContext {
	request: Request;
	env: Env;
	ctx: ExecutionContext;
	url: URL;
	requestId: string;
	isProduction: boolean;
	// Hono apps for delegating
	adminUserApp: Hono;
	adminRbacApp: Hono;
	adminClientApp: Hono;
	rbacApp: Hono;
	// Services
	adminEnterpriseRoutes: AdminEnterpriseRoutes;
}

/**
 * Route result - either a Response or null (not handled)
 */
type RouteResult = Response | null;

/**
 * Rewrite a request path for sub-app routing
 */
function rewriteRequest(request: Request, originalPath: string, newPath: string): Request {
	const url = new URL(request.url);
	url.pathname = newPath;

	return new Request(url.toString(), {
		method: request.method,
		headers: request.headers,
		body: request.body,
		redirect: request.redirect,
	});
}

/**
 * Handle admin RBAC routes (/admin/roles/*)
 */
async function handleAdminRbacRoutes(rctx: RouterContext): Promise<RouteResult> {
	const { url, request, env, ctx, adminRbacApp, isProduction } = rctx;

	if (!url.pathname.startsWith('/admin/roles')) {
		return null;
	}

	// Rewrite /admin/roles → /roles (not /) so rbacAdminEndpoints routes match
	// rbacAdminEndpoints has: router.get("/roles", ...), router.post("/roles", ...), etc.
	const rewrittenPath = url.pathname.replace(/^\/admin/, '');
	const rewrittenRequest = rewriteRequest(request, url.pathname, rewrittenPath);

	logger.info('[RBAC] Handling admin RBAC request', {
		originalPath: url.pathname,
		rewrittenPath,
		method: request.method,
		hasAuth: !!request.headers.get('Authorization'),
		actingUserId: request.headers.get('X-Acting-User-Id') || 'missing',
	});

	const response = await adminRbacApp.fetch(rewrittenRequest, env, ctx);

	// Clone response to read body for logging
	const responseClone = response.clone();
	let responseBody = 'non-json';
	try {
		responseBody = JSON.stringify(await responseClone.json());
	} catch {
		// Not JSON, ignore
	}

	logger.info('[RBAC] Admin RBAC response', {
		status: response.status,
		path: rewrittenPath,
		responseBody: responseBody.substring(0, 500), // Truncate for logging
	});

	if (response.status !== 404) {
		return addSecurityHeaders(response, isProduction);
	}

	return null;
}

/**
 * Handle admin user CRUD routes (/admin/users/*)
 */
async function handleAdminUserRoutes(rctx: RouterContext): Promise<RouteResult> {
	const { url, request, env, ctx, adminUserApp, isProduction } = rctx;

	// Token-related paths go to adminEnterpriseRoutes
	const isTokenManagementPath =
		url.pathname === '/admin/users/tokens/revoke' ||
		url.pathname.match(/^\/admin\/users\/[^/]+\/tokens$/);

	if (!url.pathname.startsWith('/admin/users') || isTokenManagementPath) {
		return null;
	}

	const rewrittenPath = url.pathname.replace(/^\/admin\/users/, '') || '/';
	const rewrittenRequest = rewriteRequest(request, url.pathname, rewrittenPath);

	const response = await adminUserApp.fetch(rewrittenRequest, env, ctx);
	if (response.status !== 404) {
		return addSecurityHeaders(response, isProduction);
	}

	return null;
}

/**
 * Handle admin client routes (/admin/clients/*)
 * Uses OpenAuth's clientAdminRoutes for proper scopes/metadata handling
 */
async function handleAdminClientRoutes(rctx: RouterContext): Promise<RouteResult> {
	const { url, request, env, ctx, adminClientApp, isProduction } = rctx;

	if (!url.pathname.startsWith('/admin/clients')) {
		return null;
	}

	// Rewrite /admin/clients/* -> /clients/*
	const rewrittenPath = url.pathname.replace(/^\/admin\/clients/, '/clients') || '/clients';
	const rewrittenRequest = rewriteRequest(request, url.pathname, rewrittenPath);

	const response = await adminClientApp.fetch(rewrittenRequest, env, ctx);
	if (response.status !== 404) {
		return addSecurityHeaders(response, isProduction);
	}

	return null;
}

/**
 * Handle admin enterprise routes (audit, tokens, health, metrics)
 */
async function handleAdminEnterpriseRoutes(rctx: RouterContext): Promise<RouteResult> {
	const { url, request, env, ctx, adminEnterpriseRoutes, isProduction } = rctx;

	const isTokenManagementPath =
		url.pathname === '/admin/users/tokens/revoke' ||
		url.pathname.match(/^\/admin\/users\/[^/]+\/tokens$/);

	const shouldHandle =
		url.pathname === '/admin/audit' ||
		url.pathname.startsWith('/admin/audit-logs') ||
		// Client routes now handled by adminClientApp (OpenAuth's clientAdminRoutes)
		isTokenManagementPath ||
		url.pathname === '/admin/health' ||
		url.pathname === '/admin/metrics';

	if (!shouldHandle) {
		return null;
	}

	const response = await adminEnterpriseRoutes.handle(request, env, ctx);
	if (response.status !== 404) {
		return addSecurityHeaders(response, isProduction);
	}

	return null;
}

/**
 * Handle admin stats routes (/admin/stats/*)
 */
async function handleAdminStatsRoutes(rctx: RouterContext): Promise<RouteResult> {
	const { url, request, env, ctx, isProduction } = rctx;

	if (!url.pathname.startsWith('/admin/stats')) {
		return null;
	}

	const response = await adminStatsRoutes.fetch(request, env, ctx);
	if (response.status !== 404) {
		return addSecurityHeaders(response, isProduction);
	}

	return null;
}

/**
 * Handle admin session management routes (/admin/sessions/*)
 */
async function handleAdminSessionRoutes(rctx: RouterContext): Promise<RouteResult> {
	const { url, request, env, ctx, isProduction } = rctx;

	// Let OpenAuth handle these specific routes
	const isOpenAuthSessionRoute =
		url.pathname === '/admin/sessions/revoke' || url.pathname === '/admin/sessions/revoke-user';

	const shouldHandle =
		!isOpenAuthSessionRoute &&
		(url.pathname.startsWith('/admin/sessions') ||
			url.pathname.match(/^\/admin\/users\/[^/]+\/sessions/));

	if (!shouldHandle) {
		return null;
	}

	const response = await adminSessionRoutes.fetch(request, env, ctx);
	if (response.status !== 404) {
		return addSecurityHeaders(response, isProduction);
	}

	return null;
}

/**
 * Handle admin tenant management routes (/admin/tenants/*)
 */
async function handleAdminTenantRoutes(rctx: RouterContext): Promise<RouteResult> {
	const { url, request, env, ctx, isProduction } = rctx;

	if (!url.pathname.startsWith('/admin/tenants')) {
		return null;
	}

	const adminTenantRoutes = new AdminTenantRoutes(env.AUTH_DB);
	const response = await adminTenantRoutes.handle(request, env, ctx);
	if (response.status !== 404) {
		return addSecurityHeaders(response, isProduction);
	}

	return null;
}

/**
 * Handle admin DLQ management routes (/admin/dlq/*)
 */
async function handleAdminDlqRoutes(rctx: RouterContext): Promise<RouteResult> {
	const { url, request, env, ctx, isProduction } = rctx;

	if (!url.pathname.startsWith('/admin/dlq')) {
		return null;
	}

	logger.debug('Handling admin DLQ request', { pathname: url.pathname });
	const dlqResponse = await routeAdminDLQ(request, env, ctx);
	if (dlqResponse) {
		rctx.ctx.waitUntil(logger.finalizeRequest());
		return addSecurityHeaders(dlqResponse, isProduction);
	}

	return null;
}

/**
 * Handle session CORS preflight (/session/*)
 */
function handleSessionCorsOptions(rctx: RouterContext): RouteResult {
	const { url, request, env } = rctx;

	if (!url.pathname.startsWith('/session/') || request.method !== 'OPTIONS') {
		return null;
	}

	const origin = request.headers.get('Origin');

	const headers: HeadersInit = {
		'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type, Authorization, Cookie',
		'Access-Control-Allow-Credentials': 'true',
		'Access-Control-Max-Age': '86400',
		Vary: 'Origin',
	};
	if (isAllowedOrigin(origin, env)) {
		headers['Access-Control-Allow-Origin'] = origin;
	}

	return new Response(null, { status: 204, headers });
}

/**
 * Handle account selection page (/select-account)
 */
async function handleSelectAccountRoute(rctx: RouterContext): Promise<RouteResult> {
	const { url, request, env, isProduction } = rctx;

	if (url.pathname !== '/select-account') {
		return null;
	}

	// Get browser session for multi-account support
	const sessionToken = parseSessionCookie(request.headers.get('Cookie') || '');
	let browserSession = null;

	if (sessionToken) {
		const browserSessionService = new BrowserSessionService(env.AUTH_DB);
		browserSession = await browserSessionService.getBrowserSessionByToken(sessionToken);
	}

	if (request.method === 'GET') {
		const response = await handleSelectAccountGet(request, env, browserSession);
		return addSecurityHeaders(response, isProduction);
	} else if (request.method === 'POST') {
		const response = await handleSelectAccountPost(request, env, browserSession);
		return addSecurityHeaders(response, isProduction);
	}

	return null;
}

/**
 * Handle user-facing RBAC routes (/api/permissions/*)
 */
async function handleApiPermissionsRoutes(rctx: RouterContext): Promise<RouteResult> {
	const { url, request, env, ctx, rbacApp, isProduction } = rctx;

	if (!url.pathname.startsWith('/api/permissions')) {
		return null;
	}

	const rewrittenPath = url.pathname.replace(/^\/api\/permissions/, '') || '/';
	const rewrittenRequest = rewriteRequest(request, url.pathname, rewrittenPath);

	// TODO: Set userId, tenantId, appId from auth middleware
	const response = await rbacApp.fetch(rewrittenRequest, env, ctx);
	if (response.status !== 404) {
		return addSecurityHeaders(response, isProduction);
	}

	return null;
}

/**
 * Handle redirect routes (/, /docs)
 */
function handleRedirectRoutes(rctx: RouterContext): RouteResult {
	const { url, env, ctx, isProduction } = rctx;

	if (url.pathname === '/' || url.pathname === '') {
		logger.debug('Redirecting to profile app');

		if (!env.PROFILE_APP_URL) {
			logger.error('PROFILE_APP_URL not configured');
			ctx.waitUntil(logger.finalizeRequest());
			const response = new Response('Profile app URL not configured', { status: 500 });
			return addSecurityHeaders(response, isProduction);
		}

		ctx.waitUntil(logger.finalizeRequest());
		const response = Response.redirect(env.PROFILE_APP_URL, 302);
		return addSecurityHeaders(response, isProduction);
	}

	if (url.pathname === '/docs') {
		logger.debug('Redirecting /docs to profile app');

		if (!env.PROFILE_APP_URL) {
			logger.error('PROFILE_APP_URL not configured');
			ctx.waitUntil(logger.finalizeRequest());
			const response = new Response('Profile app URL not configured', { status: 500 });
			return addSecurityHeaders(response, isProduction);
		}

		ctx.waitUntil(logger.finalizeRequest());
		const response = Response.redirect(env.PROFILE_APP_URL, 302);
		return addSecurityHeaders(response, isProduction);
	}

	return null;
}

/**
 * Handle test routes (development only)
 */
async function handleTestRoutes(rctx: RouterContext): Promise<RouteResult> {
	const { request, env, ctx, isProduction } = rctx;

	const testResponse = await routeTestEndpoints(request, env, ctx, isProduction);
	if (testResponse) {
		return addSecurityHeaders(testResponse, isProduction);
	}

	return null;
}

/**
 * Handle direct auth access without OAuth params (/authorize)
 */
function handleAuthorizeRedirect(rctx: RouterContext): RouteResult {
	const { url, env, ctx, isProduction } = rctx;

	if (url.pathname !== '/authorize') {
		return null;
	}

	const redirectUri = url.searchParams.get('redirect_uri');
	const clientId = url.searchParams.get('client_id');

	// If no redirect_uri or client_id, sign in through the profile app: its
	// /login starts a real sign-in (state + PKCE). A code sent straight to its
	// callback without them could only end on its error page.
	if (!redirectUri || !clientId) {
		logger.debug('Direct auth access without OAuth params, redirecting to the profile sign-in');

		const profileLogin = new URL('/login', env.PROFILE_APP_URL || 'http://localhost:3302');
		const lang = url.searchParams.get('lang');
		if (lang === 'ar') profileLogin.searchParams.set('lang', lang);

		ctx.waitUntil(logger.finalizeRequest());
		return Response.redirect(profileLogin.toString(), 302);
	}

	// Let enterprise issuer handle valid authorize requests
	return null;
}

/**
 * Handle token endpoint rate limiting
 */
async function handleTokenRateLimit(rctx: RouterContext): Promise<RouteResult> {
	const { url, request, env, ctx, requestId, isProduction } = rctx;

	const isTokenEndpoint =
		url.pathname === '/token' ||
		url.pathname === '/token/introspect' ||
		url.pathname === '/token/revoke';

	if (!isTokenEndpoint) {
		return null;
	}

	const clientIP = getClientIP(request);

	// Workers Rate Limiting (AU-1): per user for refreshes, per client for our own
	// server-side apps, per IP otherwise. No shared key, no KV writes.
	const buckets = tokenRateLimitBuckets(request, url.pathname, clientIP, await readTokenRequestFields(request));
	for (const bucket of buckets) {
		const limiter = bucket.limiter === 'client' ? env.TOKEN_CLIENT_LIMITER : env.TOKEN_LIMITER;
		if (await withinRateLimit(limiter, bucket.key)) continue;

		const retryAfter = RATE_LIMIT_PERIOD_SECONDS;
		logger.warn('Rate limit exceeded for token endpoint', {
			clientIP,
			bucket: bucket.limiter,
			endpoint: url.pathname,
		});

		// Emit rate limit exceeded audit event
		const auditEvent = createRateLimitExceededEvent(url.pathname, 0, RATE_LIMIT_PERIOD_SECONDS, retryAfter, {
			ipAddress: clientIP,
			userAgent: request.headers.get('User-Agent') ?? undefined,
			requestId,
		});
		ctx.waitUntil(getAuditEmitter().emit(auditEvent));

		// Track rate limit in analytics
		trackEvent(env, {
			event: 'rate_limit_hit',
			ipAddress: clientIP,
			userAgent: request.headers.get('User-Agent') ?? undefined,
		});

		ctx.waitUntil(logger.finalizeRequest());
		const response = new Response(
			JSON.stringify({
				error: 'rate_limit_exceeded',
				error_description: 'Too many requests. Please try again in 1 minute(s).',
			}),
			{
				status: 429,
				headers: {
					'Content-Type': 'application/json',
					'Retry-After': String(retryAfter),
				},
			}
		);
		return addSecurityHeaders(response, isProduction);
	}

	// Don't return a response - let the issuer handle the actual token request
	return null;
}

/**
 * Main router function
 *
 * Routes requests to appropriate handlers based on pathname.
 * Returns null if no route matched (request should go to OpenAuth issuer).
 */
/**
 * Paths that must never be reachable without admin credentials, regardless of
 * which handler (ours or the OpenAuth issuer) ends up serving them.
 * Default-deny: individual handlers may add stricter checks on top.
 */
function isAdminOnlyPath(pathname: string): boolean {
	if (pathname === '/admin/sessions/dashboard') return false; // HTML shell; checks session itself
	return (
		pathname === '/admin' ||
		pathname.startsWith('/admin/') ||
		pathname === '/tenants' ||
		pathname.startsWith('/tenants/')
	);
}

const adminGuardApp = new Hono<{ Bindings: Env }>();
adminGuardApp.use('*', requireAdmin());
adminGuardApp.all('*', (c) => c.body(null, 204));

/**
 * Returns null when the request carries valid admin credentials
 * (admin-scoped M2M token + admin acting user, or an admin user token),
 * otherwise the 401/403 response to send.
 */
async function enforceAdmin(rctx: RouterContext): Promise<Response | null> {
	const { request, env, ctx } = rctx;
	if (request.method === 'OPTIONS') return null;

	const m2m = await adminGuardApp.fetch(request.clone(), env, ctx);
	if (m2m.status === 204) return null;

	if (request.headers.get('Authorization')) {
		try {
			await verifyAdminAuth(request.clone(), env);
			return null;
		} catch {
			// fall through to the M2M error response
		}
	}
	return addSecurityHeaders(m2m, rctx.isProduction);
}

export async function routeRequest(rctx: RouterContext): Promise<RouteResult> {
	const { url, request } = rctx;
	const { pathname } = url;

	if (isAdminOnlyPath(pathname)) {
		const denied = await enforceAdmin(rctx);
		if (denied) return denied;
	}

	// Handle exact path matches first
	switch (pathname) {
		case '/':
		case '':
		case '/docs':
			return handleRedirectRoutes(rctx);

		case '/logout':
			return await handleLogout(rctx.request, rctx.env, rctx.ctx, rctx.requestId, rctx.isProduction);

		case '/callback':
			return await handleCallback(rctx.request, rctx.ctx, rctx.isProduction);

		case '/select-account':
			return await handleSelectAccountRoute(rctx);

		case '/settings/sessions':
			return await handleSettingsSessions(rctx.request, rctx.env, rctx.isProduction);

		case '/ui/account-switcher':
			return await handleAccountSwitcher(rctx.request, rctx.env, rctx.isProduction);

		case '/admin/sessions/dashboard':
			return await handleAdminSessionsDashboard(rctx.request, rctx.env, rctx.isProduction);

		case '/admin/audit':
		case '/admin/health':
		case '/admin/metrics':
			return await handleAdminEnterpriseRoutes(rctx);

		case '/authorize':
			return handleAuthorizeRedirect(rctx);

		// Auth's published themes (public, read-only): ids/names apps may pass as ?theme=
		case '/themes':
			if (request.method !== 'GET') return methodNotAllowed('GET');
			return handlePublicThemeList(rctx.env);

		case '/themes/resolve':
			if (request.method !== 'GET') return methodNotAllowed('GET');
			return handleThemeResolve(rctx.env, url);

		// Self-service account deletion and export (Epic 9.7): the user's own token
		case '/account':
			if (request.method !== 'DELETE') return methodNotAllowed('DELETE');
			return handleDeleteAccount(request, rctx.env, rctx.ctx, rctx.requestId);

		case '/account/export':
			if (request.method !== 'GET') return methodNotAllowed('GET');
			return handleAccountExport(request, rctx.env);

		// Sign out of all devices (#437): revokes every sign-in of the caller
		case '/account/sign-out-all':
			if (request.method !== 'POST') return methodNotAllowed('POST');
			return handleSignOutAll(request, rctx.env, rctx.ctx, rctx.requestId);
	}

	// Handle prefix-based routes
	if (pathname.startsWith('/admin/')) {
		return await routeAdminPaths(rctx);
	}

	if (pathname.startsWith('/themes/assets/') && request.method === 'GET') {
		return handleThemeAsset(rctx.env, pathname.slice('/themes/assets/'.length));
	}

	if (pathname.startsWith('/session/')) {
		if (request.method === 'OPTIONS') {
			return handleSessionCorsOptions(rctx);
		}
		return null; // Let OpenAuth handle session API
	}

	if (pathname.startsWith('/api/permissions')) {
		return await handleApiPermissionsRoutes(rctx);
	}

	// Invites: provisioning API for client apps (client credentials) and the public link page (docs/USER_INVITES.md)
	if (pathname === '/provisioning/invites' || pathname.startsWith('/provisioning/invites/')) {
		const response = await routeInviteProvisioning(request, rctx.env, rctx.ctx, rctx.requestId);
		return response ? addSecurityHeaders(response, rctx.isProduction) : null;
	}
	if (pathname.startsWith('/invite/')) {
		const theme = openauthThemeFor(compileBuiltin(BUILTIN_DEFAULT_THEME, url.origin)!);
		const response = await routeInvitePage(request, rctx.env, rctx.ctx, rctx.requestId, theme);
		return response ? addSecurityHeaders(response, rctx.isProduction) : null;
	}

	// Moderation requests from client apps (client credentials, docs/MODERATION_REQUESTS.md)
	if (pathname === '/moderation/requests' || pathname.startsWith('/moderation/requests/')) {
		const response = await routeModerationClient(request, rctx.env, rctx.ctx, rctx.requestId);
		return response ? addSecurityHeaders(response, rctx.isProduction) : null;
	}

	if (pathname.startsWith('/test/')) {
		return await handleTestRoutes(rctx);
	}

	// Token rate limiting (doesn't return response if allowed, just checks)
	if (pathname === '/token' || pathname === '/token/introspect' || pathname === '/token/revoke') {
		return await handleTokenRateLimit(rctx);
	}

	// No route matched - let OpenAuth issuer handle it
	return null;
}

/**
 * Route admin paths to appropriate handlers
 */
async function routeAdminPaths(rctx: RouterContext): Promise<RouteResult> {
	const { pathname } = rctx.url;

	// Check specific patterns first
	if (pathname.startsWith('/admin/roles')) {
		return await handleAdminRbacRoutes(rctx);
	}

	if (pathname.startsWith('/admin/users')) {
		// Token management goes to enterprise routes
		if (pathname === '/admin/users/tokens/revoke' || pathname.match(/^\/admin\/users\/[^/]+\/tokens$/)) {
			return await handleAdminEnterpriseRoutes(rctx);
		}
		// Session management
		if (pathname.match(/^\/admin\/users\/[^/]+\/sessions/)) {
			return await handleAdminSessionRoutes(rctx);
		}
		// User CRUD
		return await handleAdminUserRoutes(rctx);
	}

	if (pathname.startsWith('/admin/clients')) {
		return await handleAdminClientRoutes(rctx);
	}

	if (pathname.startsWith('/admin/audit-logs')) {
		return await handleAdminEnterpriseRoutes(rctx);
	}

	if (pathname.startsWith('/admin/stats')) {
		return await handleAdminStatsRoutes(rctx);
	}

	if (pathname.startsWith('/admin/sessions')) {
		// Let OpenAuth handle revoke endpoints
		if (pathname === '/admin/sessions/revoke' || pathname === '/admin/sessions/revoke-user') {
			return null;
		}
		return await handleAdminSessionRoutes(rctx);
	}

	if (pathname.startsWith('/admin/tenants')) {
		return await handleAdminTenantRoutes(rctx);
	}

	if (pathname.startsWith('/admin/dlq')) {
		return await handleAdminDlqRoutes(rctx);
	}

	if (pathname === '/admin/moderation-requests' || pathname.startsWith('/admin/moderation-requests/')) {
		return await handleAdminModerationRoutes(rctx);
	}

	if (pathname === '/admin/deletions' || pathname.startsWith('/admin/deletions/')) {
		const response = await deletionAdminRoutes.fetch(rctx.request, rctx.env, rctx.ctx);
		return addSecurityHeaders(response, rctx.isProduction);
	}

	if (pathname === '/admin/themes' || pathname.startsWith('/admin/themes/')) {
		const response = await adminThemeRoutes.fetch(rctx.request, rctx.env, rctx.ctx);
		return addSecurityHeaders(response, rctx.isProduction);
	}

	return null;
}

/**
 * Moderation requests queue and decisions (/admin/moderation-requests/*). An
 * approval queues the action (moderation/queue.ts).
 */
async function handleAdminModerationRoutes(rctx: RouterContext): Promise<RouteResult> {
	const response = await moderationAdminRoutes().fetch(rctx.request, rctx.env, rctx.ctx);
	return addSecurityHeaders(response, rctx.isProduction);
}
