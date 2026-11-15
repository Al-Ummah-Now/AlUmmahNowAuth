/**
 * /select-account checks the client against oauth_clients by its id (the
 * table has no client_id column: every lookup failed with a D1 error, so the
 * account picker answered 500), and its error page never echoes the input.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { setupDatabase } from '../test-setup';
import { getClient, validateClient } from '../middleware/client-validation';
import { handleSelectAccountGet } from '../routes/select-account';

const DB = () => (env as unknown as Env).AUTH_DB;
const CLIENT = { id: 'select-account-test-client', redirect: 'https://app.example.test/callback' };

beforeAll(async () => {
	await setupDatabase();
	const now = Date.now();
	await DB().prepare(`INSERT OR IGNORE INTO tenants (id, name, created_at, updated_at) VALUES ('default', 'Default', ?, ?)`).bind(now, now).run();
	await DB()
		.prepare(`INSERT OR REPLACE INTO oauth_clients (id, tenant_id, name, redirect_uris, enabled, created_at, updated_at) VALUES (?, 'default', 'Picker Test', ?, 1, ?, ?)`)
		.bind(CLIENT.id, JSON.stringify([CLIENT.redirect]), now, now)
		.run();
	await DB()
		.prepare(`INSERT OR REPLACE INTO oauth_clients (id, tenant_id, name, redirect_uris, enabled, created_at, updated_at) VALUES ('disabled-client', 'default', 'Off', ?, 0, ?, ?)`)
		.bind(JSON.stringify([CLIENT.redirect]), now, now)
		.run();
});

describe('validateClient', () => {
	it('finds a client by id and checks the exact redirect URI', async () => {
		expect(await validateClient(DB(), CLIENT.id, CLIENT.redirect)).toEqual({ valid: true, client: { id: CLIENT.id, name: 'Picker Test', redirectUris: [CLIENT.redirect] } });
		expect((await validateClient(DB(), CLIENT.id, 'https://evil.example/callback')).valid).toBe(false);
		expect((await validateClient(DB(), 'disabled-client', CLIENT.redirect)).valid).toBe(false);
		expect(await validateClient(DB(), 'nope', CLIENT.redirect)).toEqual({ valid: false, error: 'Invalid client_id' });
		expect((await getClient(DB(), CLIENT.id))?.name).toBe('Picker Test');
	});
});

describe('GET /select-account', () => {
	const get = (query: string) => handleSelectAccountGet(new Request(`https://auth.test/select-account?${query}`), env as unknown as Env, null);

	it('a valid client without a session goes on to sign-in (no 500)', async () => {
		const res = await get(`client_id=${CLIENT.id}&redirect_uri=${encodeURIComponent(CLIENT.redirect)}&state=s1`);
		expect(res.status).toBe(302);
		const to = new URL(res.headers.get('Location')!);
		expect(to.pathname).toBe('/authorize');
		expect(to.searchParams.get('client_id')).toBe(CLIENT.id);
	});

	it('an unknown client is refused without echoing what was sent', async () => {
		const res = await get(`client_id=${encodeURIComponent('<script>alert(1)</script>')}&redirect_uri=${encodeURIComponent(CLIENT.redirect)}`);
		expect(res.status).toBe(400);
		const body = await res.text();
		expect(body).not.toContain('<script>');
		expect(body).toContain('Invalid client_id');
	});
});
