/**
 * AlUmmahNowAuth#211: a public client (registered without a secret) must send
 * PKCE (S256) on /authorize, so a code is only ever redeemed by the browser or
 * app that started the sign-in. Confidential clients are unaffected.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../index';
import { setupDatabase } from '../test-setup';
import { PROFILE, registerTestClients } from './helpers/clients';

const PUBLIC = { id: 'public-pkce-app', redirect: 'http://localhost:3302/public-callback' };
// A valid S256 challenge shape (43 base64url characters)
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

async function authorize(clientId: string, redirect: string, pkce: boolean) {
	const q = new URLSearchParams({ client_id: clientId, response_type: 'code', state: 's', redirect_uri: redirect });
	if (pkce) {
		q.set('code_challenge', CHALLENGE);
		q.set('code_challenge_method', 'S256');
	}
	const ctx = createExecutionContext();
	const res = await worker.fetch(
		new Request(`http://localhost:3301/authorize?${q}`, { headers: { host: 'localhost:3301' }, redirect: 'manual' }),
		env as unknown as Env,
		ctx
	);
	await waitOnExecutionContext(ctx);
	return res;
}

describe('PKCE for public clients (worker)', () => {
	beforeAll(async () => {
		await setupDatabase();
		await registerTestClients();
		const now = Date.now();
		await (env as unknown as Env).AUTH_DB.prepare(
			`INSERT OR REPLACE INTO oauth_clients (id, tenant_id, name, client_secret_hash, grant_types, scopes, redirect_uris, metadata, enabled, created_at, updated_at)
			 VALUES (?, 'default', 'Public app', NULL, '["authorization_code","refresh_token"]', '[]', ?, '{}', 1, ?, ?)`
		)
			.bind(PUBLIC.id, JSON.stringify([PUBLIC.redirect]), now, now)
			.run();
	});

	it('rejects /authorize without code_challenge for a public client', async () => {
		const res = await authorize(PUBLIC.id, PUBLIC.redirect, false);
		const location = res.headers.get('location') ?? '';
		expect(location).not.toContain('/password/authorize');
		expect(new URL(location).searchParams.get('error')).toBe('invalid_request');
	});

	it('serves the sign-in form when the public client sends S256', async () => {
		const res = await authorize(PUBLIC.id, PUBLIC.redirect, true);
		expect(res.status).toBe(302);
		expect(res.headers.get('location')).toContain('/password/authorize');
	});

	it('leaves confidential clients alone', async () => {
		const res = await authorize(PROFILE.id, PROFILE.redirect, false);
		expect(res.headers.get('location')).toContain('/password/authorize');
	});
});
