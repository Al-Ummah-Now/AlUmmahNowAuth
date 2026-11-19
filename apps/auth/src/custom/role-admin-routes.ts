/**
 * Accounts admin role pages (apps/admin roles.$id, roles._index), mounted on the admin RBAC app
 * ahead of OpenAuth's rbacAdminEndpoints (requireAdmin + admin context already applied):
 *
 *   GET /roles/:roleId/users  the accounts that hold a role (rbac_user_roles by role_id, indexed),
 *                             system accounts and deleted users left out, at most 500
 *   GET /permissions          every permission, grouped by resource (a small table, bounded)
 *
 * The admin's role page called both, but neither existed (the page showed no users and no
 * permissions to grant). Removing a user from a role is the existing
 * DELETE /admin/users/:userId/roles/:roleId (it signs the user out and is audited).
 */
import { Hono } from 'hono';
import { SYSTEM_USER_IDS_SQL } from '../security/system-accounts';

export const ROLE_USERS_LIMIT = 500;
export const PERMISSIONS_LIMIT = 1000;

interface PermissionRow {
	id: string;
	name: string;
	client_id: string;
	resource: string;
	action: string;
	description: string | null;
	created_at: number;
}

export function roleAdminRoutes(db: D1Database) {
	const app = new Hono<{ Variables: { tenantId?: string } }>();

	app.get('/roles/:roleId/users', async (c) => {
		const roleId = c.req.param('roleId');
		const tenantId = c.get('tenantId') || 'default';
		const rows = await db
			.prepare(
				`SELECT u.id, u.email, ur.assigned_at, ur.assigned_by
				 FROM rbac_user_roles ur JOIN users u ON u.id = ur.user_id
				 WHERE ur.role_id = ? AND ur.tenant_id = ? AND u.deleted_at IS NULL AND u.id NOT IN (${SYSTEM_USER_IDS_SQL})
				 ORDER BY ur.assigned_at DESC LIMIT ${ROLE_USERS_LIMIT}`,
			)
			.bind(roleId, tenantId)
			.all<{ id: string; email: string; assigned_at: number; assigned_by: string | null }>();
		return c.json(rows.results ?? []);
	});

	app.get('/permissions', async (c) => {
		const rows = await db
			.prepare(`SELECT id, name, client_id, resource, action, description, created_at FROM rbac_permissions ORDER BY resource, action LIMIT ${PERMISSIONS_LIMIT}`)
			.all<PermissionRow>();
		const permissions: Record<string, (PermissionRow & { is_system: boolean })[]> = {};
		for (const row of rows.results ?? []) (permissions[row.resource] ??= []).push({ ...row, is_system: false });
		return c.json({ total: rows.results?.length ?? 0, permissions });
	});

	return app;
}
