/**
 * @fileoverview Admin authorization middleware for Hono routes
 *
 * Provides middleware for requiring admin role and specific permissions.
 * Used by admin session management APIs to enforce authorization.
 * Supports both session-based and M2M authentication.
 */

import type { Context, MiddlewareHandler } from 'hono';
import type { AccountSession } from '../types/sessions';
import { verifyM2MAuth, hasM2MAuth, M2MAuthError } from './m2m-auth';

type AdminContext = Context<{
	Bindings: Env;
	Variables: {
		browserSession: unknown;
		activeAccount: AccountSession | null;
		tenantId: string;
		adminUser: { userId: string; email: string; roles: string[] } | null;
	};
}>;

/**
 * Middleware that requires admin role
 *
 * Supports both session-based and M2M authentication:
 * - Session: Uses activeAccount from context
 * - M2M: Uses Bearer token with X-Acting-User-Id header
 *
 * Returns 401 if not authenticated
 * Returns 403 if not an admin
 *
 * Sets adminUser in context variables for audit logging
 */
export function requireAdmin(requiredScope?: string): MiddlewareHandler<{
	Bindings: Env;
	Variables: {
		browserSession: unknown;
		activeAccount: AccountSession | null;
		tenantId: string;
		adminUser: { userId: string; email: string; roles: string[] } | null;
	};
}> {
	return async (c: AdminContext, next) => {
		// Check for M2M auth first (Bearer token)
		if (hasM2MAuth(c.req.raw)) {
			try {
				const m2mAuth = await verifyM2MAuth(c.req.raw, c.env, requiredScope || 'admin:*');

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
				const user = await c.env.AUTH_DB.prepare(`SELECT email FROM user WHERE id = ?`)
					.bind(actingUserId)
					.first<{ email: string }>();

				c.set('adminUser', {
					userId: actingUserId,
					email: user?.email || '',
					roles,
				});

				// Set tenantId from M2M token or default
				c.set('tenantId', m2mAuth.tenantId || 'default');

				await next();
				return;
			} catch (error) {
				if (error instanceof M2MAuthError) {
					return c.json({ error: error.message, code: error.code }, error.statusCode as 401 | 403);
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
			FROM user u
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
 * Middleware that requires specific permission
 *
 * Must be used after requireAdmin middleware
 *
 * Returns 403 if user doesn't have the required permission
 */
export function requirePermission(permission: string): MiddlewareHandler<{
	Bindings: Env;
	Variables: {
		browserSession: unknown;
		activeAccount: AccountSession | null;
		tenantId: string;
		adminUser: { userId: string; email: string; roles: string[] } | null;
	};
}> {
	return async (c: AdminContext, next) => {
		const adminUser = c.get('adminUser');

		if (!adminUser) {
			return c.json({ error: 'Forbidden: Admin context not set' }, 403);
		}

		// Super admins and admins have all permissions for now
		// Fine-grained permission checking can be added when permissions are populated
		if (adminUser.roles.includes('super_admin') || adminUser.roles.includes('admin')) {
			await next();
			return;
		}

		// Check if user has the required permission through their roles
		try {
			const hasPermission = await c.env.AUTH_DB.prepare(`
				SELECT COUNT(*) as count
				FROM rbac_permissions p
				JOIN rbac_role_permissions rp ON p.id = rp.permission_id
				JOIN rbac_user_roles ur ON rp.role_id = ur.role_id
				WHERE ur.user_id = ?
				  AND p.name = ?
				  AND (ur.expires_at IS NULL OR ur.expires_at > unixepoch() * 1000)
			`)
				.bind(adminUser.userId, permission)
				.first<{ count: number }>();

			if (!hasPermission || hasPermission.count === 0) {
				return c.json({ error: `Forbidden: ${permission} permission required` }, 403);
			}
		} catch {
			// If RBAC tables don't have data yet, allow admins through
			// This is a fallback for initial setup
		}

		await next();
	};
}
