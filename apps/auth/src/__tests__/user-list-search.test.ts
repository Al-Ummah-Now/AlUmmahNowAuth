/**
 * GET /admin/users?search= — the admin's user autocomplete: name, email or an exact id,
 * against the real (miniflare) D1. Wildcards typed by the admin match literally.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import '../test-setup';
import { userListRoutes } from '../custom/user-list-routes';

const T = 'default';

async function seed(id: string, email: string, name: string | null, deleted = false) {
	const now = Date.now();
	await env.AUTH_DB.prepare(
		`INSERT INTO users (id, tenant_id, email, name, status, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
	)
		.bind(id, T, email, name, now, now, deleted ? now : null)
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

async function search(q: string): Promise<{ ids: string[]; total: number }> {
	const res = await app().request(`/?search=${encodeURIComponent(q)}&limit=8`);
	expect(res.status).toBe(200);
	const body = (await res.json()) as { users: { id: string }[]; total_count: number };
	return { ids: body.users.map((u) => u.id).sort(), total: body.total_count };
}

describe('GET /admin/users?search=', () => {
	beforeEach(async () => {
		await env.AUTH_DB.prepare(`INSERT OR IGNORE INTO tenants (id, name, status, created_at, updated_at) VALUES (?, 'Default', 'active', 0, 0)`).bind(T).run().catch(() => undefined);
		await env.AUTH_DB.prepare('DELETE FROM users WHERE tenant_id = ?').bind(T).run();
		await seed('usr_aaa111', 'omar@example.com', 'Omar Farouk');
		await seed('usr_bbb222', 'aisha@example.com', 'Aisha');
		await seed('usr_ccc333', 'omar_100%@example.com', null);
		await seed('usr_ddd444', 'omar.gone@example.com', 'Omar Gone', true);
	});

	it('matches the name or the email, case-insensitively, never a deleted user', async () => {
		expect((await search('OMAR')).ids).toEqual(['usr_aaa111', 'usr_ccc333']);
		expect((await search('farouk')).ids).toEqual(['usr_aaa111']);
		expect((await search('aisha@')).ids).toEqual(['usr_bbb222']);
	});

	it('matches an exact id', async () => {
		expect((await search('usr_bbb222')).ids).toEqual(['usr_bbb222']);
	});

	it('takes % and _ literally', async () => {
		expect((await search('100%')).ids).toEqual(['usr_ccc333']);
		expect((await search('r_1')).ids).toEqual(['usr_ccc333']);
		expect((await search('%')).ids).toEqual(['usr_ccc333']);
	});

	it('counts what it matches', async () => {
		expect((await search('omar')).total).toBe(2);
	});

	it('count=none (a picker opening): the newest page, paged, without the COUNT', async () => {
		const res = await app().request('/?limit=2&count=none');
		expect(res.status).toBe(200);
		const body = (await res.json()) as { users: { id: string }[]; total_count: number | null; pagination: { hasMore: boolean; nextCursor: string | null } };
		expect(body.total_count).toBeNull();
		expect(body.users).toHaveLength(2);
		expect(body.pagination.hasMore).toBe(true);
		const next = (await (await app().request(`/?limit=2&count=none&cursor=${body.pagination.nextCursor}`)).json()) as { users: { id: string }[] };
		expect(next.users.map((u) => u.id)).not.toContain(body.users[0].id);
		expect([...body.users, ...next.users].map((u) => u.id)).not.toContain('usr_ddd444');
	});
});
