/**
 * GET /admin/users/role-counts — the dashboard's users per role and admin count, over every live
 * user (not the newest page of 100: QA has 45k users and the dashboard read only that page).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import '../test-setup';
import { clearUserTotals, userListRoutes, type RoleCounts } from '../custom/user-list-routes';

const T = 'default';
const now = Date.now();

async function user(id: string, deleted = false) {
	await env.AUTH_DB.prepare(
		`INSERT INTO users (id, tenant_id, email, name, status, created_at, updated_at, deleted_at) VALUES (?, ?, ?, NULL, 'active', ?, ?, ?)`,
	)
		.bind(id, T, `${id}@example.com`, now, now, deleted ? now : null)
		.run();
}
async function grant(userId: string, roleId: string, expiresAt: number | null = null) {
	await env.AUTH_DB.prepare(`INSERT INTO rbac_user_roles (user_id, role_id, tenant_id, assigned_at, expires_at, assigned_by) VALUES (?, ?, ?, ?, ?, 'test')`)
		.bind(userId, roleId, T, now, expiresAt)
		.run();
}

function app() {
	const a = new Hono();
	a.use('*', async (c, next) => {
		c.set('tenantId' as never, T as never);
		await next();
	});
	a.route('/', userListRoutes(env.AUTH_DB));
	return a;
}

async function counts(): Promise<RoleCounts> {
	const res = await app().request('/role-counts');
	expect(res.status).toBe(200);
	return (await res.json()) as RoleCounts;
}

describe('GET /admin/users/role-counts', () => {
	beforeEach(async () => {
		await env.AUTH_DB.prepare(`INSERT OR IGNORE INTO tenants (id, name, status, created_at, updated_at) VALUES (?, 'Default', 'active', 0, 0)`).bind(T).run().catch(() => undefined);
		await env.AUTH_DB.prepare('DELETE FROM rbac_user_roles WHERE tenant_id = ?').bind(T).run();
		await env.AUTH_DB.prepare('DELETE FROM users WHERE tenant_id = ?').bind(T).run();
		for (const [id, name] of [['rc_admin', 'Admin'], ['rc_super', 'Super Admin'], ['rc_member', 'Member'], ['rc_editor', 'Editor']]) {
			await env.AUTH_DB.prepare(`INSERT OR REPLACE INTO rbac_roles (id, name, tenant_id, is_system_role, created_at, updated_at) VALUES (?, ?, ?, 1, 0, 0)`).bind(id, name, T).run();
		}
		clearUserTotals();
	});

	it('counts every live user, beyond the list page of 100, and agrees with itself on admins', async () => {
		// 150 members: more than a list page; two of them are admins, one is admin and super admin
		for (let i = 0; i < 150; i++) {
			await user(`usr_m${i}`);
			await grant(`usr_m${i}`, 'rc_member');
		}
		await grant('usr_m0', 'rc_admin');
		await grant('usr_m1', 'rc_admin');
		await grant('usr_m1', 'rc_super');
		await grant('usr_m2', 'rc_editor');

		const c = await counts();
		expect(c.roles).toEqual([
			{ id: 'rc_member', name: 'Member', user_count: 150 },
			{ id: 'rc_admin', name: 'Admin', user_count: 2 },
			{ id: 'rc_editor', name: 'Editor', user_count: 1 },
			{ id: 'rc_super', name: 'Super Admin', user_count: 1 },
		]);
		// usr_m1 holds both admin roles: one admin, not two
		expect(c.admin_users).toBe(2);
	});

	it('leaves out deleted users and expired grants', async () => {
		await user('usr_live');
		await user('usr_gone', true);
		await user('usr_lapsed');
		await grant('usr_live', 'rc_admin');
		await grant('usr_gone', 'rc_admin');
		await grant('usr_lapsed', 'rc_super', now - 60_000);
		await grant('usr_lapsed', 'rc_member', now + 60_000);

		const c = await counts();
		expect(c.roles).toEqual([
			{ id: 'rc_admin', name: 'Admin', user_count: 1 },
			{ id: 'rc_member', name: 'Member', user_count: 1 },
		]);
		expect(c.admin_users).toBe(1);
	});

	it('an empty tenant has no roles held and no admins', async () => {
		expect(await counts()).toEqual({ roles: [], admin_users: 0 });
	});
});
