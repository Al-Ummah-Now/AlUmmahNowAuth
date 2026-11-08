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

const VIEWER_MOBILE = '31389afb-d4f8-4c26-9492-4c77f4d07e65';
const VIEWER_DESKTOP = 'ce7de8a4-59dd-4682-ab4d-105399105294';
const STUDIO_MOBILE = '45364a42-21f4-4359-a76c-0a1e6615fd7b';
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
		for (const s of statements(qaMigration)) await (env as unknown as Env).AUTH_DB.prepare(s).run();
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

	it('prod universal links use the prod host, QA the QA host', () => {
		expect(rows(prodMigration).flatMap((c) => c.redirects).some((u) => u.includes('.qa.'))).toBe(false);
		expect(rows(qaMigration).flatMap((c) => c.redirects).filter((u) => u.startsWith('https://')).every((u) => u.includes('videos.qa.'))).toBe(true);
	});
});
