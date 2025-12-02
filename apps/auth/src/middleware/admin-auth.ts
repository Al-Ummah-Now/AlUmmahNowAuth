/**
 * @fileoverview Admin authorization middleware for Hono routes
 *
 * Provides middleware for requiring admin role and specific permissions.
 * Used by admin session management APIs to enforce authorization.
 */

import type { Context, MiddlewareHandler } from 'hono';
import type { AccountSession } from '../types/sessions';

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
 * Returns 401 if not authenticated
 * Returns 403 if not an admin
 *
 * Sets adminUser in context variables for audit logging
 */
export function requireAdmin(): MiddlewareHandler<{
	Bindings: Env;
	Variables: {
		browserSession: unknown;
		activeAccount: AccountSession | null;
		tenantId: string;
		adminUser: { userId: string; email: string; roles: string[] } | null;
	};
}> {
	return async (c: AdminContext, next) => {
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
			FROM user_roles ur
			JOIN roles r ON ur.role_id = r.id
			WHERE ur.user_id = ?
			  AND ur.is_active = 1
			  AND (ur.expires_at IS NULL OR ur.expires_at > datetime('now'))
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

		// Super admins have all permissions
		if (adminUser.roles.includes('super_admin')) {
			await next();
			return;
		}

		// Check if user has the required permission through their roles
		const hasPermission = await c.env.AUTH_DB.prepare(`
			SELECT COUNT(*) as count
			FROM permissions p
			JOIN role_permissions rp ON p.id = rp.permission_id
			JOIN user_roles ur ON rp.role_id = ur.role_id
			WHERE ur.user_id = ?
			  AND p.name = ?
			  AND ur.is_active = 1
			  AND (ur.expires_at IS NULL OR ur.expires_at > datetime('now'))
		`)
			.bind(adminUser.userId, permission)
			.first<{ count: number }>();

		if (!hasPermission || hasPermission.count === 0) {
			return c.json({ error: `Forbidden: ${permission} permission required` }, 403);
		}

		await next();
	};
}
