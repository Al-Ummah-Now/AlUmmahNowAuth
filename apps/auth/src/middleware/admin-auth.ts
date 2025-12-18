/**
 * @fileoverview Admin authorization middleware for Hono routes
 *
 * Provides middleware for requiring admin role and specific permissions.
 * Used by admin session management APIs to enforce authorization.
 * Supports both session-based and M2M authentication.
 *
 * Uses OpenAuth's bearerAuth with JWKS for M2M token verification
 * and requireScope for scope checking.
 */

import type { Context, MiddlewareHandler } from 'hono';
import type { AccountSession } from '../types/sessions';
import { bearerAuth, extractBearerToken, requireScope, requireAnyScope } from '@al-ummah-now/openauth';

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
			try {
				// Use OpenAuth's bearerAuth with JWKS
				const issuer = c.env.OPENAUTH_ISSUER || 'http://localhost:3301';
				const jwksUrl = `${issuer}/.well-known/jwks.json`;

				// Create and run bearerAuth middleware
				const authMiddleware = bearerAuth({
					jwksUrl,
					issuer,
					requireM2M: true,
				});

				// Run the middleware - it will set token, tenantId, clientId, scopes
				await authMiddleware(c, async () => {});

				// Get acting user from header (required for M2M)
				const actingUserId = c.req.header('X-Acting-User-Id');
				if (!actingUserId) {
					return c.json({ error: 'M2M requests must include X-Acting-User-Id header' }, 401);
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
				const isAdmin = roles.includes('admin') || roles.includes('super_admin');

				if (!isAdmin) {
					return c.json({ error: 'Forbidden: Acting user must be admin' }, 403);
				}

				// Get user email
				const user = await c.env.AUTH_DB.prepare(`SELECT email FROM users WHERE id = ?`)
					.bind(actingUserId)
					.first<{ email: string }>();

				c.set('adminUser', {
					userId: actingUserId,
					email: user?.email || '',
					roles,
				});

				await next();
				return;
			} catch (error) {
				// Handle OpenAuth middleware errors
				if (error instanceof Error) {
					const statusCode = error.name === 'InsufficientScopeError' ? 403 : 401;
					return c.json({ error: error.message }, statusCode);
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
			SELECT u.id, u.email
			FROM users u
			WHERE u.id = ?
		`)
			.bind(activeAccount.userId)
			.first<{ id: string; email: string }>();

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

		// Check for admin role
		const isAdmin = roles.includes('admin') || roles.includes('super_admin');

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
		if (adminUser.roles.includes('super_admin') || adminUser.roles.includes('admin')) {
			await next();
			return;
		}

		return c.json({ error: 'Forbidden: Admin access required' }, 403);
	};
}
