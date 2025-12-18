/**
 * @fileoverview Admin Dashboard Statistics Routes
 *
 * Provides aggregated statistics for the admin dashboard:
 * - User counts (total, admins, regular users)
 * - Role statistics (total, system roles, custom roles)
 * - User distribution by role
 *
 * SECURITY: All operations require admin role
 * PERFORMANCE: Uses optimized COUNT queries with proper indexes
 */

import { Hono } from 'hono';
import { requireAdmin, requirePermission } from '../middleware/admin-auth';
import { rateLimit } from '../middleware/rate-limit';

// Define Hono app with admin variables
type AdminVariables = {
	browserSession: unknown;
	activeAccount: unknown;
	tenantId: string;
	adminUser: { userId: string; email: string; roles: string[] } | null;
};

const adminStatsRoutes = new Hono<{ Bindings: Env; Variables: AdminVariables }>().basePath('/admin');

/**
 * Rate Limiting Configuration for Admin Stats Endpoints
 *
 * Stats endpoints are read-heavy and should allow frequent access
 */
const adminRateLimit = {
	stats: rateLimit({ limit: 100, window: 60, keyPrefix: 'admin:stats:view' }),
};

// Apply admin role check to all routes
adminStatsRoutes.use('*', requireAdmin());

/**
 * GET /admin/stats
 * Get comprehensive dashboard statistics
 *
 * Returns:
 * - users: { total, admins, regular }
 * - roles: { total, systemRoles, customRoles }
 * - usersByRole: Array of { roleId, roleName, userCount }
 *
 * Response Example:
 * {
 *   "users": {
 *     "total": 150,
 *     "admins": 5,
 *     "regular": 145
 *   },
 *   "roles": {
 *     "total": 8,
 *     "systemRoles": 3,
 *     "customRoles": 5
 *   },
 *   "usersByRole": [
 *     { "roleId": "role_user_default", "roleName": "user", "userCount": 145 },
 *     { "roleId": "role_admin_default", "roleName": "admin", "userCount": 5 }
 *   ]
 * }
 */
adminStatsRoutes.get(
	'/stats',
	adminRateLimit.stats,
	requirePermission('analytics:read'),
	async (c) => {
		const tenantId = c.get('tenantId');

		try {
			// Run all stats queries in parallel for performance
			const [
				totalUsersResult,
				adminCountResult,
				totalRolesResult,
				systemRolesResult,
				usersByRoleResults,
			] = await Promise.all([
				// Total users in tenant
				c.env.AUTH_DB.prepare(`
					SELECT COUNT(*) as count
					FROM users
					WHERE tenant_id = ?
				`)
					.bind(tenantId)
					.first<{ count: number }>(),

				// Admin users count (users with admin or super_admin role)
				// Using LOWER() for case-insensitive comparison (role names may be 'Admin', 'Super Admin')
				c.env.AUTH_DB.prepare(`
					SELECT COUNT(DISTINCT ur.user_id) as count
					FROM rbac_user_roles ur
					JOIN rbac_roles r ON ur.role_id = r.id
					WHERE r.tenant_id = ?
					AND LOWER(r.name) IN ('admin', 'super admin', 'super_admin')
					AND (ur.expires_at IS NULL OR ur.expires_at > unixepoch() * 1000)
				`)
					.bind(tenantId)
					.first<{ count: number }>(),

				// Total roles in tenant
				c.env.AUTH_DB.prepare(`
					SELECT COUNT(*) as count
					FROM rbac_roles
					WHERE tenant_id = ?
				`)
					.bind(tenantId)
					.first<{ count: number }>(),

				// System roles count (roles with is_system_role = 1)
				c.env.AUTH_DB.prepare(`
					SELECT COUNT(*) as count
					FROM rbac_roles
					WHERE tenant_id = ?
					AND is_system_role = 1
				`)
					.bind(tenantId)
					.first<{ count: number }>(),

				// Users by role with role names
				c.env.AUTH_DB.prepare(`
					SELECT
						r.id as role_id,
						r.name as role_name,
						COUNT(DISTINCT ur.user_id) as user_count
					FROM rbac_roles r
					LEFT JOIN rbac_user_roles ur ON r.id = ur.role_id
						AND (ur.expires_at IS NULL OR ur.expires_at > unixepoch() * 1000)
					WHERE r.tenant_id = ?
					GROUP BY r.id, r.name
					ORDER BY user_count DESC, r.name ASC
				`)
					.bind(tenantId)
					.all<{ role_id: string; role_name: string; user_count: number }>(),
			]);

			const totalUsers = totalUsersResult?.count || 0;
			const adminCount = adminCountResult?.count || 0;
			const totalRoles = totalRolesResult?.count || 0;
			const systemRoles = systemRolesResult?.count || 0;

			// Calculate regular users (non-admin users)
			const regularUsers = totalUsers - adminCount;

			// Calculate custom roles (total - system)
			const customRoles = totalRoles - systemRoles;

			// Transform usersByRole results
			const usersByRole = (usersByRoleResults.results || []).map((row) => ({
				roleId: row.role_id,
				roleName: row.role_name,
				userCount: row.user_count,
			}));

			return c.json({
				users: {
					total: totalUsers,
					admins: adminCount,
					regular: regularUsers,
				},
				roles: {
					total: totalRoles,
					systemRoles: systemRoles,
					customRoles: customRoles,
				},
				usersByRole: usersByRole,
			});
		} catch (error) {
			console.error('Error fetching admin stats:', error);
			return c.json(
				{
					error: 'Internal server error',
					code: 'STATS_FETCH_ERROR',
				},
				500
			);
		}
	}
);

export default adminStatsRoutes;
