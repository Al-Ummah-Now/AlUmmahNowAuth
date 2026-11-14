/**
 * @fileoverview Admin authorization middleware for Hono routes
 *
 * Provides middleware for requiring admin role and specific permissions.
 * Used by admin session management APIs to enforce authorization.
 * Supports both session-based and M2M authentication.
 *
 * Uses jose with locally cached JWKS for M2M token verification to avoid
 * worker-to-self HTTP call issues on Cloudflare Workers.
 */

import type { Context, MiddlewareHandler } from 'hono';
import type { AccountSession } from '../types/sessions';
import { extractBearerToken, requireScope, requireAnyScope } from '@al-ummah-now/openauth';
import { logger } from '../logger';
import { createLocalJWKSet, jwtVerify, decodeJwt } from 'jose';
import { getJWKS } from '../utils/jwks-cache';
import { flagSystemAccountAttempt, isSystemUser } from '../security/system-accounts';

/** The execution context when there is one (unit tests call middleware without it). */
function ctxOf(c: { executionCtx: ExecutionContext }): ExecutionContext | undefined {
	try {
		return c.executionCtx;
	} catch {
		return undefined;
	}
}

// Re-export OpenAuth's scope middleware for use in routes
export { requireScope, requireAnyScope };

type AdminContext = Context<{
	Bindings: Env;
	Variables: {
		browserSession: unknown;
		activeAccount: AccountSession | null;
		tenantId: string;
		scopes: string[];
		token: unknown;
		clientId: string;
		adminUser: { userId: string; email: string; roles: string[] } | null;
	};
}>;

/**
 * Check if request has Bearer token
 */
function hasM2MAuth(request: Request): boolean {
	const authHeader = request.headers.get('Authorization');
	return extractBearerToken(authHeader) !== null;
}

/**
 * Middleware that requires admin role
 *
 * Supports both session-based and M2M authentication:
 * - Session: Uses activeAccount from context
 * - M2M: Uses Bearer token with X-Acting-User-Id header (via OpenAuth bearerAuth)
 *
 * Returns 401 if not authenticated
 * Returns 403 if not an admin
 *
 * Sets adminUser in context variables for audit logging
 */
export function requireAdmin(_requiredScope?: string): MiddlewareHandler<{
	Bindings: Env;
	Variables: {
		browserSession: unknown;
		activeAccount: AccountSession | null;
		tenantId: string;
		scopes: string[];
		token: unknown;
		clientId: string;
		adminUser: { userId: string; email: string; roles: string[] } | null;
	};
}> {
	return async (c: AdminContext, next) => {
		// Check for M2M auth first (Bearer token)
		if (hasM2MAuth(c.req.raw)) {
			logger.info('[requireAdmin] M2M auth detected');
			try {
				// Use local JWKS verification to avoid worker-to-self HTTP call issues
				const issuer = c.env.OPENAUTH_ISSUER || 'http://localhost:3301';
				const authHeader = c.req.header('Authorization');
				const token = extractBearerToken(authHeader);

				if (!token) {
					return c.json({ error: 'No bearer token provided' }, 401);
				}

				// Decode token to check claims before verification
				const decoded = decodeJwt(token);

				// Verify this is an M2M token
				if (!decoded.client_id) {
					return c.json({ error: 'Invalid token: not an M2M token' }, 401);
				}

				// Get JWKS from local storage
				const jwks = await getJWKS(c.env);
				const JWKS = createLocalJWKSet(jwks);

				// Verify the token
				const { payload } = await jwtVerify(token, JWKS, {
					issuer,
				});

				// Set context values
				const scopes = payload.scope
					? typeof payload.scope === 'string'
						? payload.scope.split(' ')
						: (payload.scope as string[])
					: [];
				// Only clients that were granted an admin scope may act as an admin.
				// Without this, any M2M client (e.g. a backend service) could
				// impersonate an admin user via X-Acting-User-Id.
				const hasAdminScope = scopes.some((s) => s === 'admin' || s.startsWith('admin:'));
				if (!hasAdminScope) {
					logger.warn('[requireAdmin] M2M token lacks admin scope', {
						clientId: payload.client_id,
					});
					return c.json({ error: 'Forbidden: admin scope required' }, 403);
				}

				c.set('tenantId', (payload.tenant_id as string) || 'default');
				c.set('clientId', payload.client_id as string);
				c.set('scopes', scopes);
				c.set('token', payload);

				logger.info('[requireAdmin] Local JWKS verification passed', {
					tenantId: c.get('tenantId'),
					clientId: c.get('clientId'),
				});

				// Get acting user from header (required for M2M)
				const actingUserId = c.req.header('X-Acting-User-Id');
				if (!actingUserId) {
					logger.warn('[requireAdmin] Missing X-Acting-User-Id header');
					return c.json({ error: 'M2M requests must include X-Acting-User-Id header' }, 401);
				}

				// A system account never acts as an admin (security/system-accounts.ts)
				const actingRow = await c.env.AUTH_DB.prepare(`SELECT email, metadata FROM users WHERE id = ?`)
					.bind(actingUserId)
					.first<{ email: string; metadata: string | null }>();
				if (isSystemUser({ id: actingUserId, metadata: actingRow?.metadata })) {
					flagSystemAccountAttempt(c.env, ctxOf(c), {
						userId: actingUserId,
						attempt: 'acting_admin',
						detail: 'm2m',
						request: c.req.raw,
						actorId: String(payload.client_id),
					});
					return c.json({ error: 'Forbidden: system accounts cannot act as an admin' }, 403);
				}

				// Fetch acting user's roles from DB (never trust client headers)
				const rolesResult = await c.env.AUTH_DB.prepare(`
					SELECT r.name
					FROM rbac_user_roles ur
					JOIN rbac_roles r ON ur.role_id = r.id
					WHERE ur.user_id = ?
					  AND (ur.expires_at IS NULL OR ur.expires_at > unixepoch() * 1000)
				`)
					.bind(actingUserId)
					.all<{ name: string }>();

				const roles = rolesResult.results?.map((r) => r.name) || [];
				logger.info('[requireAdmin] Acting user roles', {
					actingUserId,
					roles,
					rolesCount: roles.length,
				});

				// Case-insensitive role check - OpenAuth seeds 'Admin' and 'Super Admin' (capitalized)
				const roleNamesLower = roles.map((r) => r.toLowerCase());
				const isAdmin = roleNamesLower.includes('admin') || roleNamesLower.includes('super admin');

				if (!isAdmin) {
					logger.warn('[requireAdmin] Acting user not admin', { actingUserId, roles });
					return c.json({ error: 'Forbidden: Acting user must be admin' }, 403);
				}

				c.set('adminUser', {
					userId: actingUserId,
					email: actingRow?.email || '',
					roles,
				});

				await next();
				return;
			} catch (error) {
				// Handle OpenAuth middleware errors
				// Log the detail, but never return library/internal error text to the client
				logger.warn('[requireAdmin] M2M authentication failed', {
					errorName: error instanceof Error ? error.name : typeof error,
					error: error instanceof Error ? error.message : String(error),
				});
				if (error instanceof Error && error.name === 'InsufficientScopeError') {
					return c.json({ error: 'Forbidden: insufficient scope' }, 403);
				}
				return c.json({ error: 'M2M authentication failed' }, 401);
			}
		}

		// Fall back to session-based auth
		const activeAccount = c.get('activeAccount');

		if (!activeAccount) {
			return c.json({ error: 'Unauthorized' }, 401);
		}

		// Get user with roles
		const user = await c.env.AUTH_DB.prepare(`
			SELECT u.id, u.email, u.metadata
			FROM users u
			WHERE u.id = ?
		`)
			.bind(activeAccount.userId)
			.first<{ id: string; email: string; metadata: string | null }>();

		// A system account never acts as an admin, even with a session (security/system-accounts.ts)
		if (isSystemUser({ id: activeAccount.userId, metadata: user?.metadata })) {
			flagSystemAccountAttempt(c.env, ctxOf(c), { userId: activeAccount.userId, attempt: 'acting_admin', detail: 'session', request: c.req.raw });
			return c.json({ error: 'Forbidden: system accounts cannot act as an admin' }, 403);
		}

		if (!user) {
			return c.json({ error: 'User not found' }, 404);
		}

		// Get user roles
		const rolesResult = await c.env.AUTH_DB.prepare(`
			SELECT r.name
			FROM rbac_user_roles ur
			JOIN rbac_roles r ON ur.role_id = r.id
			WHERE ur.user_id = ?
			  AND (ur.expires_at IS NULL OR ur.expires_at > unixepoch() * 1000)
		`)
			.bind(user.id)
			.all<{ name: string }>();

		const roles = rolesResult.results?.map((r) => r.name) || [];

		// Check for admin role (case-insensitive - OpenAuth seeds 'Admin' and 'Super Admin')
		const roleNamesLower = roles.map((r) => r.toLowerCase());
		const isAdmin = roleNamesLower.includes('admin') || roleNamesLower.includes('super admin');

		if (!isAdmin) {
			return c.json({ error: 'Forbidden: Admin access required' }, 403);
		}

		// Set admin user in context for audit logging
		c.set('adminUser', {
			userId: user.id,
			email: user.email,
			roles,
		});

		await next();
	};
}

/**
 * @deprecated Use requireScope from '@al-ummah-now/openauth/middleware' instead.
 * This is kept for backward compatibility during migration.
 *
 * For admin routes, use:
 *   requireAdmin() -> sets scopes in context
 *   requireScope('admin:users') -> checks scope from context
 */
export function requirePermission(_permission: string): MiddlewareHandler<{
	Bindings: Env;
	Variables: {
		browserSession: unknown;
		activeAccount: AccountSession | null;
		tenantId: string;
		scopes: string[];
		token: unknown;
		clientId: string;
		adminUser: { userId: string; email: string; roles: string[] } | null;
	};
}> {
	return async (c: AdminContext, next) => {
		const adminUser = c.get('adminUser');

		if (!adminUser) {
			return c.json({ error: 'Forbidden: Admin context not set' }, 403);
		}

		// All admins pass through - scope checking is done by requireScope
		// Case-insensitive role check (OpenAuth seeds 'Admin' and 'Super Admin')
		const roleNamesLower = adminUser.roles.map((r) => r.toLowerCase());
		if (roleNamesLower.includes('super admin') || roleNamesLower.includes('admin')) {
			await next();
			return;
		}

		return c.json({ error: 'Forbidden: Admin access required' }, 403);
	};
}
