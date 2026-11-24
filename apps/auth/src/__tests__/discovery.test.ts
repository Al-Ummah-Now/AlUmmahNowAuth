/**
 * AUTH-R4: the discovery documents, through the auth worker, list only what it
 * serves, and /userinfo refuses a bad token as the caller's error.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../index';
import { setupDatabase } from '../test-setup';

const ORIGIN = 'http://localhost:3301';

async function call(path: string, init: RequestInit = {}) {
	const ctx = createExecutionContext();
	const headers = new Headers(init.headers);
	headers.set('host', 'localhost:3301');
	headers.set('cf-connecting-ip', '203.0.113.21');
	const res = await worker.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers, redirect: 'manual' }), env as unknown as Env, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

describe('discovery (worker)', () => {
	beforeAll(async () => {
		await setupDatabase();
	});

	for (const path of ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration']) {
		it(`${path}: every endpoint it lists answers`, async () => {
			const doc = (await (await call(path)).json()) as Record<string, unknown>;
			const endpoints = Object.entries(doc).filter(([key]) => key.endsWith('_endpoint') || key === 'jwks_uri' || key === 'verification_uri');
			expect(endpoints.map(([key]) => key).sort()).toEqual([
				'authorization_endpoint',
				'device_authorization_endpoint',
				'introspection_endpoint',
				'jwks_uri',
				'revocation_endpoint',
				'token_endpoint',
				'userinfo_endpoint',
				'verification_uri',
			]);
			for (const [key, url] of endpoints) {
				const at = String(url).slice(ORIGIN.length);
				expect(String(url).startsWith(`${ORIGIN}/`)).toBe(true);
				const get = await call(at);
				const post = await call(at, {
					method: 'POST',
					headers: { 'content-type': 'application/x-www-form-urlencoded' },
					body: 'token=x&grant_type=refresh_token',
				});
				const served = [get.status, post.status].some((s) => s !== 404 && s < 500);
				expect({ key, served, get: get.status, post: post.status }).toMatchObject({ key, served: true });
			}
			expect(doc).not.toHaveProperty('registration_endpoint');
			expect(doc.response_types_supported).toEqual(['code', 'token']);
			expect(doc.code_challenge_methods_supported).toEqual(['S256']);
			expect(doc.service_documentation).toBe('https://alummahnow.dev/en/auth/');
		});
	}

	it('a bad token on /userinfo is 401, never a page or a server error', async () => {
		const part = (v: unknown) => btoa(JSON.stringify(v)).replace(/=+$/, '');
		const forged = (alg: string) => `${part({ alg })}.${part({ iss: ORIGIN, mode: 'access', type: 'user' })}.eHh4`;
		for (const token of ['nonsense', forged('HS256'), forged('ES256'), forged('none')]) {
			const res = await call('/userinfo', { headers: { Authorization: `Bearer ${token}` } });
			expect(res.status).toBe(401);
			expect(res.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
			expect(await res.json()).toMatchObject({ error: 'invalid_token' });
		}
	});
});
