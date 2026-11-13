/**
 * Epic 9.1: the native apps' OAuth clients (migrations/ and migrations-qa/0013_native_clients.sql)
 * are public PKCE clients with exact redirect URIs: custom schemes, universal
 * links, and loopback (desktop, any port).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../index';
import { setupDatabase } from '../test-setup';
import qaMigration from '../../migrations-qa/0013_native_clients.sql?raw';
import prodMigration from '../../migrations/0013_native_clients.sql?raw';
import adminQaMigration from '../../migrations-qa/0036_admin_native_clients.sql?raw';
import adminProdMigration from '../../migrations/0036_admin_native_clients.sql?raw';
import adminWindowsQaMigration from '../../migrations-qa/0039_admin_windows_client.sql?raw';
import adminWindowsProdMigration from '../../migrations/0039_admin_windows_client.sql?raw';
import adminAndroidQaMigration from '../../migrations-qa/0040_admin_android_client.sql?raw';
import adminAndroidProdMigration from '../../migrations/0040_admin_android_client.sql?raw';

const VIEWER_MOBILE = '31389afb-d4f8-4c26-9492-4c77f4d07e65';
const VIEWER_DESKTOP = 'ce7de8a4-59dd-4682-ab4d-105399105294';
const STUDIO_MOBILE = '45364a42-21f4-4359-a76c-0a1e6615fd7b';
const ADMIN_IOS = '77330b47-5747-4058-ba00-921e159f1ced';
const ADMIN_MAC = '1c230211-7b90-4d0a-be9d-3068ebd79d5b';
const ADMIN_WINDOWS = '306b6f10-d9f0-4609-84a1-23c92da978e9';
const ADMIN_ANDROID = '5b44a4f7-d369-4d12-bc69-028d0276604a';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

const statements = (sql: string) =>
	sql
		.split('\n')
		.filter((l) => !l.startsWith('--'))
		.join('\n')
		.split(';')
		.map((s) => s.trim())
		.filter(Boolean);

async function authorize(clientId: string, redirect: string, pkce = true) {
	const q = new URLSearchParams({ client_id: clientId, response_type: 'code', state: 's', redirect_uri: redirect });
	if (pkce) {
		q.set('code_challenge', CHALLENGE);
		q.set('code_challenge_method', 'S256');
	}
	const ctx = createExecutionContext();
	const res = await worker.fetch(new Request(`http://localhost:3301/authorize?${q}`, { headers: { host: 'localhost:3301' }, redirect: 'manual' }), env as unknown as Env, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

describe('native app clients (worker)', () => {
	beforeAll(async () => {
		await setupDatabase();
		for (const s of [...statements(qaMigration), ...statements(adminQaMigration), ...statements(adminWindowsQaMigration), ...statements(adminAndroidQaMigration)]) await (env as unknown as Env).AUTH_DB.prepare(s).run();
	});

	it('a custom-scheme redirect with PKCE gets the sign-in form', async () => {
		for (const [id, uri] of [
			[VIEWER_MOBILE, 'alummahnow://auth/callback'],
			[VIEWER_MOBILE, 'https://videos.qa.alummahnow.net/app/auth/callback'],
			[STUDIO_MOBILE, 'alummahnow-studio://auth/callback'],
		]) {
			const res = await authorize(id, uri);
			expect(res.status, uri).toBe(302);
			expect(res.headers.get('location'), uri).toContain('/password/authorize');
		}
	});

	it('PKCE is required: without it the app gets invalid_request on its own redirect', async () => {
		const res = await authorize(VIEWER_MOBILE, 'alummahnow://auth/callback', false);
		expect(res.status).toBe(302);
		const location = new URL(res.headers.get('location')!);
		expect(location.protocol).toBe('alummahnow:');
		expect(location.searchParams.get('error')).toBe('invalid_request');
		expect(location.searchParams.get('state')).toBe('s');
	});

	it('desktop loopback redirects may use any port, nothing else varies', async () => {
		expect((await authorize(VIEWER_DESKTOP, 'http://127.0.0.1:49152/auth/callback')).status).toBe(302);
		expect((await authorize(VIEWER_DESKTOP, 'http://127.0.0.1:49152/elsewhere')).status).toBe(400);
	});

	it('the admin app signs in only on alummahnow-admin://auth/callback, with PKCE', async () => {
		for (const id of [ADMIN_IOS, ADMIN_MAC, ADMIN_WINDOWS, ADMIN_ANDROID]) {
			const res = await authorize(id, 'alummahnow-admin://auth/callback');
			expect(res.status).toBe(302);
			expect(res.headers.get('location')).toContain('/password/authorize');
			expect((await authorize(id, 'alummahnow-studio://auth/callback')).status).toBe(400);
			expect((await authorize(id, 'http://127.0.0.1:49152/auth/callback')).status).toBe(400);
			const noPkce = new URL((await authorize(id, 'alummahnow-admin://auth/callback', false)).headers.get('location')!);
			expect(noPkce.searchParams.get('error')).toBe('invalid_request');
		}
		expect((await authorize(STUDIO_MOBILE, 'alummahnow-admin://auth/callback')).status).toBe(400);
	});

	it("rejects another app's scheme and unregistered URIs (exact match)", async () => {
		expect((await authorize(VIEWER_MOBILE, 'alummahnow-studio://auth/callback')).status).toBe(400);
		expect((await authorize(VIEWER_MOBILE, 'alummahnow://auth/callback?x=1')).status).toBe(400);
		expect((await authorize(VIEWER_MOBILE, 'alummahnow://evil/callback')).status).toBe(400);
	});
});

describe('native client migrations', () => {
	const rows = (sql: string) =>
		statements(sql).map((s) => {
			const m = /VALUES \('([^']+)', 'default', '[^']+', (NULL|'[^']*'), '([^']+)', '([^']+)', '([^']+)', '([^']+)'/.exec(s);
			if (!m) throw new Error(`unexpected statement: ${s.slice(0, 80)}`);
			return { id: m[1], secret: m[2], grants: JSON.parse(m[3]), redirects: JSON.parse(m[5]) as string[], metadata: JSON.parse(m[6]) };
		});

	for (const [env, sql] of [
		['qa', qaMigration],
		['prod', prodMigration],
	] as const) {
		it(`${env}: five public native clients with PKCE required`, () => {
			const r = rows(sql);
			expect(r).toHaveLength(5);
			for (const c of r) {
				expect(c.secret).toBe('NULL');
				expect(c.metadata).toMatchObject({ type: 'native', pkce: 'required' });
				expect(c.grants).not.toContain('client_credentials');
				for (const uri of c.redirects) expect(uri).toMatch(/^(alummahnow:\/\/|alummahnow-studio:\/\/|https:\/\/videos\.(qa\.)?alummahnow\.net\/app\/|http:\/\/127\.0\.0\.1\/)/);
				expect(c.redirects.some((u) => u.includes('localhost'))).toBe(false);
			}
			expect(r.filter((c) => c.grants.includes('urn:ietf:params:oauth:grant-type:device_code'))).toHaveLength(1);
		});
	}

	for (const [env, sql] of [
		['qa', adminQaMigration],
		['prod', adminProdMigration],
	] as const) {
		it(`${env}: Admin (iOS) and Admin (macOS) are public native PKCE clients on the admin scheme only`, () => {
			const r = rows(sql);
			expect(r).toHaveLength(2);
			for (const c of r) {
				expect(c.secret).toBe('NULL');
				expect(c.metadata).toMatchObject({ type: 'native', pkce: 'required' });
				expect(c.grants).toEqual(['authorization_code', 'refresh_token']);
				expect(c.redirects).toEqual(['alummahnow-admin://auth/callback']);
			}
		});
	}

	for (const [env, sql] of [
		['qa', adminWindowsQaMigration],
		['prod', adminWindowsProdMigration],
	] as const) {
		it(`${env}: Admin (Windows) is a public native PKCE client on the admin scheme only`, () => {
			const r = rows(sql);
			expect(r).toHaveLength(1);
			expect(r[0].secret).toBe('NULL');
			expect(r[0].metadata).toEqual({ type: 'native', pkce: 'required', platforms: ['windows'] });
			expect(r[0].grants).toEqual(['authorization_code', 'refresh_token']);
			expect(r[0].redirects).toEqual(['alummahnow-admin://auth/callback']);
		});
	}

	for (const [env, sql] of [
		['qa', adminAndroidQaMigration],
		['prod', adminAndroidProdMigration],
	] as const) {
		it(`${env}: Admin (Android) is a public native PKCE client on the admin scheme only`, () => {
			const r = rows(sql);
			expect(r).toHaveLength(1);
			expect(r[0].secret).toBe('NULL');
			expect(r[0].metadata).toEqual({ type: 'native', pkce: 'required', platforms: ['android'] });
			expect(r[0].grants).toEqual(['authorization_code', 'refresh_token']);
			expect(r[0].redirects).toEqual(['alummahnow-admin://auth/callback']);
		});
	}

	it('admin client ids differ between QA and prod', () => {
		const qa = [...rows(adminQaMigration), ...rows(adminWindowsQaMigration), ...rows(adminAndroidQaMigration)].map((c) => c.id);
		const prod = [...rows(adminProdMigration), ...rows(adminWindowsProdMigration), ...rows(adminAndroidProdMigration)].map((c) => c.id);
		expect(prod.some((id) => qa.includes(id))).toBe(false);
		expect(new Set([...qa, ...prod]).size).toBe(qa.length + prod.length);
	});

	it('prod universal links use the prod host, QA the QA host', () => {
		expect(rows(prodMigration).flatMap((c) => c.redirects).some((u) => u.includes('.qa.'))).toBe(false);
		expect(rows(qaMigration).flatMap((c) => c.redirects).filter((u) => u.startsWith('https://')).every((u) => u.includes('videos.qa.'))).toBe(true);
	});
});
