/**
 * /authorize only serves registered clients (CLIENT_REGISTRY_MODE=enforce in
 * dev and QA). Before, any client_id with a redirect_uri on our domain got a
 * sign-in form, so a broken client id never showed up as a failure.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../index';
import { setupDatabase } from '../test-setup';
import { PROFILE, registerTestClients } from './helpers/clients';
import { clientRegistryMode } from '../utils/sign-in-restart';

async function authorize(clientId: string, redirect: string) {
	const ctx = createExecutionContext();
	const res = await worker.fetch(
		new Request(
			`http://localhost:3301/authorize?client_id=${encodeURIComponent(clientId)}&response_type=code&state=s&redirect_uri=${encodeURIComponent(redirect)}`,
			{ headers: { host: 'localhost:3301' }, redirect: 'manual' }
		),
		env as unknown as Env,
		ctx
	);
	await waitOnExecutionContext(ctx);
	return res;
}

async function expectRejected(res: Response, reason: string) {
	expect(res.status).toBe(400);
	expect(res.headers.get('location')).toBeNull();
	const html = await res.text();
	expect(html).toContain('data-page="client-error"');
	expect(html).toContain(`data-error="${reason}"`);
}

describe('client registry (worker)', () => {
	beforeAll(async () => {
		await setupDatabase();
		await registerTestClients();
		const now = Date.now();
		await (env as unknown as Env).AUTH_DB.prepare(
			`INSERT OR REPLACE INTO oauth_clients (id, tenant_id, name, client_secret_hash, grant_types, scopes, redirect_uris, metadata, enabled, created_at, updated_at)
			 VALUES ('disabled-app', 'default', 'Disabled', 'h', '["authorization_code"]', '[]', '["http://localhost:3302/callback"]', '{}', 0, ?, ?)`
		)
			.bind(now, now)
			.run();
	});

	it('is enforced in dev', () => {
		expect(clientRegistryMode(env as unknown as Env)).toEqual({ mode: 'enforce' });
	});

	it('a registered client gets the sign-in form', async () => {
		const res = await authorize(PROFILE.id, PROFILE.redirect);
		expect(res.status).toBe(302);
		expect(res.headers.get('location')).toContain('/password/authorize');
	});

	it('rejects an unknown client_id, including "undefined" and the old admin-dashboard-m2m', async () => {
		for (const id of ['undefined', 'admin-dashboard-m2m', 'made-up']) await expectRejected(await authorize(id, PROFILE.redirect), 'unknown_client');
	});

	it('rejects a disabled client', async () => {
		await expectRejected(await authorize('disabled-app', PROFILE.redirect), 'client_disabled');
	});

	it('rejects a redirect_uri the client has not registered (exact match)', async () => {
		await expectRejected(await authorize(PROFILE.id, 'http://localhost:3302/other'), 'redirect_uri_not_registered');
		await expectRejected(await authorize(PROFILE.id, `${PROFILE.redirect}?x=1`), 'redirect_uri_not_registered');
	});

	it('parses CLIENT_REGISTRY_MODE', () => {
		expect(clientRegistryMode({ CLIENT_REGISTRY_MODE: 'report' })).toEqual({ mode: 'report' });
		expect(clientRegistryMode({ CLIENT_REGISTRY_MODE: 'off' })).toBeUndefined();
		expect(clientRegistryMode({})).toBeUndefined();
	});
});
