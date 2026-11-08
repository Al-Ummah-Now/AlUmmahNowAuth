/**
 * Epic 9.2: the device authorization grant (RFC 8628) through the auth worker:
 * a TV client gets a user code, polls /token, and the user approves on the
 * en/ar /activate page, which hands off to the normal sign-in.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../index';
import { setupDatabase } from '../test-setup';

const TV = '0d3f1c2e-7a5b-4c3d-9e8f-device000001';
const WEB = '0d3f1c2e-7a5b-4c3d-9e8f-device000002';
const ORIGIN = 'http://localhost:3301';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

async function call(path: string, init: RequestInit = {}) {
	const ctx = createExecutionContext();
	const headers = new Headers(init.headers);
	headers.set('host', 'localhost:3301');
	headers.set('cf-connecting-ip', '203.0.113.9');
	const res = await worker.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers, redirect: 'manual' }), env as unknown as Env, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

const form = (body: Record<string, string>) => ({
	method: 'POST',
	headers: { 'content-type': 'application/x-www-form-urlencoded' },
	body: new URLSearchParams(body).toString(),
});

async function startDevice(clientId = TV) {
	const res = await call('/device_authorization', form({ client_id: clientId, scope: 'openid profile offline_access' }));
	return { res, body: (await res.json()) as any };
}

async function poll(deviceCode: string, clientId = TV) {
	const res = await call('/token', form({ grant_type: DEVICE_GRANT, device_code: deviceCode, client_id: clientId }));
	return { status: res.status, body: (await res.json()) as any };
}

/** Opens the confirm page for a code: returns the CSRF token and cookie. */
async function confirm(userCode: string) {
	const res = await call(`/activate?user_code=${encodeURIComponent(userCode)}`);
	expect(res.status).toBe(200);
	const html = await res.text();
	const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
	const cookie = res.headers.get('set-cookie')?.split(';')[0];
	expect(csrf).toBeTruthy();
	expect(cookie).toBeTruthy();
	return { csrf: csrf!, cookie: cookie!, html };
}

describe('device authorization grant (worker)', () => {
	beforeAll(async () => {
		await setupDatabase();
		const db = (env as unknown as Env).AUTH_DB;
		const insert = `INSERT OR IGNORE INTO oauth_clients (id, tenant_id, name, client_secret_hash, grant_types, scopes, redirect_uris, metadata, enabled, created_at, updated_at)
			VALUES (?, 'default', ?, NULL, ?, '["openid","profile","email","offline_access"]', ?, '{"type":"native","pkce":"required"}', 1, unixepoch() * 1000, unixepoch() * 1000)`;
		await db.prepare(insert).bind(TV, 'Viewer (TV)', JSON.stringify([DEVICE_GRANT, 'refresh_token']), '[]').run();
		await db.prepare(insert).bind(WEB, 'Viewer (mobile)', '["authorization_code","refresh_token"]', '["alummahnow://auth/callback"]').run();
	});

	it('advertises the device endpoint in discovery', async () => {
		const res = await call('/.well-known/oauth-authorization-server');
		const doc = (await res.json()) as any;
		expect(doc.device_authorization_endpoint).toBe(`${ORIGIN}/device_authorization`);
		expect(doc.grant_types_supported).toContain(DEVICE_GRANT);
	});

	it('issues codes that live 10 minutes with a 5 s polling interval', async () => {
		const { res, body } = await startDevice();
		expect(res.status).toBe(200);
		expect(body.user_code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-?[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
		expect(body.device_code).toBeTruthy();
		expect(body.expires_in).toBe(600);
		expect(body.interval).toBe(5);
		expect(body.verification_uri).toBe(`${ORIGIN}/activate`);
		expect(body.verification_uri_complete).toContain('user_code=');
	});

	it('clients without the device grant are refused', async () => {
		const { res, body } = await startDevice(WEB);
		expect(res.status).toBe(400);
		expect(body.error).toBe('unauthorized_client');
	});

	it('polling: pending, then slow_down when too fast', async () => {
		const { body } = await startDevice();
		expect((await poll(body.device_code)).body.error).toBe('authorization_pending');
		expect((await poll(body.device_code)).body.error).toBe('slow_down');
	});

	it('approve hands off to the normal sign-in for the TV client', async () => {
		const { body } = await startDevice();
		const { csrf, cookie, html } = await confirm(body.user_code);
		expect(html).toContain('Viewer (TV)');
		const res = await call('/activate', {
			...form({ user_code: body.user_code, csrf, action: 'approve' }),
			headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
		});
		expect(res.status).toBe(302);
		const next = new URL(res.headers.get('location')!, ORIGIN);
		expect(next.pathname).toBe('/authorize');
		expect(next.searchParams.get('client_id')).toBe(TV);
		expect(next.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/activate/callback`);
		expect(next.searchParams.get('code_challenge_method')).toBe('S256');
		// The registry accepts the device callback for this client: the sign-in form follows
		const login = await call(next.pathname + next.search);
		expect(login.status).toBe(302);
		expect(login.headers.get('location')).toContain('/password/authorize');
	});

	it('deny: the TV gets access_denied', async () => {
		const { body } = await startDevice();
		const { csrf, cookie } = await confirm(body.user_code);
		const res = await call('/activate', {
			...form({ user_code: body.user_code, csrf, action: 'deny' }),
			headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
		});
		expect(res.status).toBe(200);
		expect((await poll(body.device_code)).body.error).toBe('access_denied');
	});

	it('a wrong code shows the error on the page; Arabic is right-to-left', async () => {
		const res = await call('/activate?user_code=BCDF-GHJK&lang=ar');
		expect(res.status).toBe(400);
		const html = await res.text();
		expect(html).toContain('dir="rtl"');
	});
});
