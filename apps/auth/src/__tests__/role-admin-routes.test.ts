/**
 * The accounts admin role page's data (custom/role-admin-routes.ts): a role's users (system and
 * deleted accounts left out) and every permission grouped by resource. Before 2026-11-18 neither
 * route existed and the page showed no users and nothing to grant.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import '../test-setup';
import { roleAdminRoutes } from '../custom/role-admin-routes';
import { SYSTEM_USER_ID } from '../security/system-accounts';

const T = 'default';
const now = Date.now();
const ROLE = `role_t_${now}`;

async function user(id: string, deleted = false) {
	await env.AUTH_DB.prepare(`INSERT OR IGNORE INTO users (id, tenant_id, email, name, status, created_at, updated_at, deleted_at) VALUES (?, ?, ?, NULL, 'active', ?, ?, ?)`)
		.bind(id, T, `${id}@example.com`, now, now, deleted ? now : null)
		.run();
}
async function grant(userId: string, at: number) {
	await env.AUTH_DB.prepare(`INSERT OR IGNORE INTO rbac_user_roles (user_id, role_id, tenant_id, assigned_at, expires_at, assigned_by) VALUES (?, ?, ?, ?, NULL, 'usr_admin')`)
		.bind(userId, ROLE, T, at)
		.run();
}

function app() {
	const a = new Hono();
	a.use('*', async (c, next) => {
		c.set('tenantId' as never, T as never);
		await next();
	});
	a.route('/', roleAdminRoutes(env.AUTH_DB));
	return a;
}

describe('role admin routes', () => {
	beforeEach(async () => {
		await env.AUTH_DB.prepare(`INSERT OR IGNORE INTO tenants (id, name, status, created_at, updated_at) VALUES (?, 'Default', 'active', 0, 0)`).bind(T).run().catch(() => undefined);
		await env.AUTH_DB.prepare(`INSERT OR IGNORE INTO rbac_roles (id, name, tenant_id, description, is_system_role, created_at, updated_at) VALUES (?, ?, ?, NULL, 0, ?, ?)`)
			.bind(ROLE, ROLE, T, now, now)
			.run();
	});

	it("lists a role's live users, newest grant first, without system or deleted accounts", async () => {
		const a = `usr_ra_a_${now}`;
		const b = `usr_ra_b_${now}`;
		const gone = `usr_ra_gone_${now}`;
		await user(a);
		await user(b);
		await user(gone, true);
		await user(SYSTEM_USER_ID);
		await grant(a, now - 1000);
		await grant(b, now);
		await grant(gone, now);
		await grant(SYSTEM_USER_ID, now);
		const res = await app().request(`/roles/${ROLE}/users`);
		expect(res.status).toBe(200);
		const users = (await res.json()) as { id: string; email: string; assigned_by: string }[];
		expect(users.map((u) => u.id)).toEqual([b, a]);
		expect(users[0]).toMatchObject({ email: `${b}@example.com`, assigned_by: 'usr_admin' });
	});

	it('an unknown role has no users (not an error)', async () => {
		const res = await app().request('/roles/role_nope/users');
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual([]);
	});

	it('lists every permission grouped by resource', async () => {
		const res = await app().request('/permissions');
		expect(res.status).toBe(200);
		const body = (await res.json()) as { total: number; permissions: Record<string, { resource: string; name: string }[]> };
		expect(typeof body.total).toBe('number');
		for (const [resource, list] of Object.entries(body.permissions)) for (const p of list) expect(p.resource).toBe(resource);
	});
});
