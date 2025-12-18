/**
 * @fileoverview Admin context middleware for OpenAuth routes
 *
 * Provides middleware to set the required context variables for OpenAuth's
 * userApiRoutes and rbacAdminEndpoints:
 *
 * 1. adminContextMiddleware - Sets tenant and admin context
 *    - Sets 'tenant' or 'tenantId' for userApiRoutes
 *    - Sets 'adminId' for rbacAdminEndpoints
 *    - Sets 'isAdmin' to true
 *
 * 2. methodCompatMiddleware - Translates PUT to PATCH
 *    - OpenAuth expects PATCH for updates, but admin app may send PUT
 *    - Provides backward compatibility during migration
 */

import type { Context, Next } from 'hono';

/**
 * Middleware to set tenant and admin context for OpenAuth routes
 *
 * OpenAuth's userApiRoutes expects:
 * - c.get('tenant') with { id: string } OR c.get('tenantId')
 *
 * OpenAuth's rbacAdminEndpoints expects:
 * - c.get('tenantId'): string
 * - c.get('adminId'): string
 * - c.get('isAdmin'): boolean
 *
 * This middleware:
 * 1. Checks if tenant context is already set (from resolveTenant middleware)
 * 2. Falls back to default tenant if not set
 * 3. Extracts admin ID from existing auth context (session or M2M)
 * 4. Sets isAdmin to true (assumes auth middleware has already verified admin access)
 *
 * @param c - Hono context
 * @param next - Next middleware function
 */
export async function adminContextMiddleware(c: Context, next: Next): Promise<void> {
	// Check if tenantId is already set by tenant middleware
	let tenantId = c.get('tenantId');

	// If not set, use default tenant
	if (!tenantId) {
		tenantId = 'default';
		c.set('tenantId', tenantId);
	}

	// Also set tenant object for userApiRoutes compatibility
	const existingTenant = c.get('tenant');
	if (!existingTenant) {
		c.set('tenant', { id: tenantId });
	}

	// Extract admin ID from authenticated context
	// Priority: authenticatedUserId (from session) > clientId (from M2M auth)
	const adminUser = c.get('adminUser');
	const activeAccount = c.get('activeAccount');
	const clientId = c.get('clientId');

	let adminId: string | undefined;

	if (adminUser?.userId) {
		// From requireAdmin middleware (session or M2M)
		adminId = adminUser.userId;
	} else if (activeAccount?.userId) {
		// From session middleware
		adminId = activeAccount.userId;
	} else if (clientId) {
		// From M2M authentication
		adminId = clientId;
	}

	// Set admin context for rbacAdminEndpoints
	if (adminId) {
		c.set('adminId', adminId);
	}

	// Set isAdmin flag (assumes auth middleware has already verified)
	c.set('isAdmin', true);

	await next();
}

/**
 * Middleware to translate PUT to PATCH for OpenAuth compatibility
 *
 * OpenAuth expects PATCH for update operations, but the admin app
 * may be sending PUT requests. This middleware provides backward
 * compatibility during the migration period.
 *
 * IMPORTANT: This modifies the request method, which is generally
 * not recommended. Use this only as a temporary compatibility layer
 * during migration. Update the admin app to use PATCH instead.
 *
 * @param c - Hono context
 * @param next - Next middleware function
 */
export async function methodCompatMiddleware(c: Context, next: Next): Promise<void> {
	if (c.req.method === 'PUT') {
		// OpenAuth expects PATCH for updates
		// Note: We need to modify the underlying Request object
		// Hono's c.req is a wrapper around the raw Request
		Object.defineProperty(c.req, 'method', {
			value: 'PATCH',
			writable: true,
			configurable: true,
		});
	}

	await next();
}
