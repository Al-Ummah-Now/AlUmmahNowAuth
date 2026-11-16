/**
 * Admin client create/update needs the English name (`name`) and the Arabic
 * one (`metadata.name_ar`): the account selector shows the app's name in the
 * page language and never falls back to the other one.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { setupDatabase } from '../test-setup';
import { requireLocalizedClientName } from '../middleware/client-localized-name';

const DB = () => (env as unknown as Env).AUTH_DB;

const app = new Hono();
app.use('*', requireLocalizedClientName(DB));
app.post('/clients', async (c) => c.json({ ok: true, body: await c.req.json() }, 201));
app.patch('/clients/:id', async (c) => c.json({ ok: true, body: await c.req.json() }));

const call = (method: string, path: string, body: unknown) =>
	app.request(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

beforeAll(async () => {
	await setupDatabase();
	const now = Date.now();
	await DB().prepare(`INSERT OR IGNORE INTO tenants (id, name, created_at, updated_at) VALUES ('default', 'Default', ?, ?)`).bind(now, now).run();
	for (const [id, metadata] of [['legacy-client', '{}'], ['named-client', JSON.stringify({ name_ar: 'المرئيات' })]]) {
		await DB()
			.prepare(`INSERT OR REPLACE INTO oauth_clients (id, tenant_id, name, redirect_uris, metadata, enabled, created_at, updated_at) VALUES (?, 'default', ?, '[]', ?, 1, ?, ?)`)
			.bind(id, `Videos ${id}`, metadata, now, now)
			.run();
	}
});

describe('creating a client', () => {
	it('needs both names', async () => {
		expect((await call('POST', '/clients', { name: 'Videos', metadata: { name_ar: 'المرئيات' } })).status).toBe(201);
		const noAr = await call('POST', '/clients', { name: 'Videos' });
		expect(noAr.status).toBe(400);
		expect(await noAr.json()).toMatchObject({ field: 'name_ar' });
		const noEn = await call('POST', '/clients', { name: ' ', metadata: { name_ar: 'المرئيات' } });
		expect(await noEn.json()).toMatchObject({ field: 'name' });
	});

	it('passes the body on to the client routes', async () => {
		const res = await call('POST', '/clients', { name: 'Videos', metadata: { name_ar: 'المرئيات', x: 1 } });
		expect(await res.json()).toMatchObject({ body: { metadata: { x: 1 } } });
	});
});

describe('updating a client', () => {
	it('metadata replaces the stored one, so it must carry name_ar', async () => {
		expect((await call('PATCH', '/clients/named-client', { metadata: { other: 1 } })).status).toBe(400);
		expect((await call('PATCH', '/clients/named-client', { metadata: { name_ar: 'المرئيات' } })).status).toBe(200);
	});

	it('a rename keeps the stored Arabic name; a legacy client must add one', async () => {
		expect((await call('PATCH', '/clients/named-client', { name: 'Videos app' })).status).toBe(200);
		expect((await call('PATCH', '/clients/legacy-client', { name: 'Videos app' })).status).toBe(400);
		expect((await call('PATCH', '/clients/named-client', { name: '' })).status).toBe(400);
	});

	it('other changes to a legacy client still go through', async () => {
		expect((await call('PATCH', '/clients/legacy-client', { enabled: false })).status).toBe(200);
		expect((await call('PATCH', '/clients/legacy-client', { redirect_uris: ['https://a.test/cb'] })).status).toBe(200);
	});
});
