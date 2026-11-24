import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { adminSource, deriveEnvConfig, resourceIds } from '../admin-config.ts';
import { parseJsonc } from '../jsonc.ts';
import { HOSTS, overrideHeader, runSmoke } from '../smoke.ts';

/** A fake auth deployment for the smoke checks. */
function fakeFetch(opts: { issuer?: string; deep?: object; deepStatus?: number; testRoute?: number; seen?: Headers[] } = {}): typeof fetch {
	const h = HOSTS.production;
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		opts.seen?.push(new Headers(init?.headers));
		const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
		if (url.pathname === '/.well-known/oauth-authorization-server') {
			const issuer = opts.issuer ?? h.auth;
			return json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/.well-known/jwks.json` });
		}
		if (url.pathname === '/.well-known/jwks.json') return json({ keys: [{ kid: 'k' }] });
		if (url.pathname === '/health') return json(opts.deep ?? { status: 'ok', environment: 'production', version: 'v-new', checks: { d1: true } }, opts.deepStatus ?? 200);
		if (url.pathname.startsWith('/test/')) return new Response('Not Found', { status: opts.testRoute ?? 404 });
		if (url.pathname === '/authorize') {
			// Like the issuer: public clients must send PKCE S256 (#211)
			if (url.searchParams.get('code_challenge_method') !== 'S256' || !url.searchParams.get('code_challenge')) {
				const back = new URL(url.searchParams.get('redirect_uri')!);
				back.searchParams.set('error', 'invalid_request');
				return new Response(null, { status: 302, headers: { Location: back.toString() } });
			}
			return new Response(null, { status: 302, headers: { Location: '/password/authorize' } });
		}
		if (url.pathname === '/password/authorize') return new Response('<form method="post"><input type="email" name="email"></form>', { status: 200 });
		return new Response('ok', { status: 200 });
	}) as typeof fetch;
}

describe('runSmoke', () => {
	it('passes against a healthy production deployment', async () => {
		const results = await runSmoke({ env: 'production', fetchImpl: fakeFetch() });
		expect(results.filter((r) => !r.ok)).toEqual([]);
	});

	it('fails when the issuer is the dev config (incident 2026-11-07)', async () => {
		const results = await runSmoke({ env: 'production', fetchImpl: fakeFetch({ issuer: 'http://localhost:3301' }) });
		expect(results.find((r) => r.name === 'auth: issuer metadata')?.ok).toBe(false);
	});

	it('fails when a binding does not resolve', async () => {
		const results = await runSmoke({
			env: 'production',
			fetchImpl: fakeFetch({ deepStatus: 503, deep: { status: 'degraded', environment: 'production', version: 'v', checks: { 'secret:RESEND_API_KEY': false } } }),
		});
		const deep = results.find((r) => r.name.startsWith('auth: deep health'))!;
		expect(deep.ok).toBe(false);
		expect(deep.detail).toContain('secret:RESEND_API_KEY');
	});

	it('fails when test routes answer in production', async () => {
		const results = await runSmoke({ env: 'production', fetchImpl: fakeFetch({ testRoute: 200 }) });
		expect(results.find((r) => r.name.startsWith('auth: test routes'))?.ok).toBe(false);
	});

	it('sends the version override and checks the candidate served the request', async () => {
		const seen: Headers[] = [];
		const ok = await runSmoke({ env: 'production', overrides: { 'al-ummah-now-auth': 'v-new' }, fetchImpl: fakeFetch({ seen }) });
		expect(ok.filter((r) => !r.ok)).toEqual([]);
		expect(seen[0].get('Cloudflare-Workers-Version-Overrides')).toBe('al-ummah-now-auth="v-new"');

		const stale = await runSmoke({ env: 'production', overrides: { 'al-ummah-now-auth': 'v-other' }, fetchImpl: fakeFetch() });
		expect(stale.find((r) => r.name.startsWith('auth: deep health'))?.detail).toContain('expected candidate v-other');
	});
});

describe('overrideHeader', () => {
	it('formats a structured-header dictionary', () => {
		expect(overrideHeader({ a: '1', b: '2' })).toBe('a="1", b="2"');
	});
});

describe('deriveEnvConfig (admin build)', () => {
	it('swaps env-specific keys and keeps the built bundle', () => {
		const built = { name: 'al-ummah-now-auth-admin', main: 'index.js', assets: { directory: '../client' }, vars: { A: 'prod' }, routes: [{ pattern: 'admin.auth.alummahnow.net' }], configPath: 'x', topLevelName: 'y' };
		const out = deriveEnvConfig(built, { env: { stage: { name: 'al-ummah-now-auth-admin-stage', vars: { A: 'stage' }, routes: [{ pattern: 'admin.auth.stage.alummahnow.net' }] } } }, 'stage');
		expect(out).toEqual({ name: 'al-ummah-now-auth-admin-stage', main: 'index.js', assets: { directory: '../client' }, vars: { A: 'stage' }, routes: [{ pattern: 'admin.auth.stage.alummahnow.net' }] });
	});

	it('throws for an unknown env', () => {
		expect(() => deriveEnvConfig({}, { env: {} }, 'stage')).toThrow('no env.stage');
	});

	// The build writes production's config, so every binding has to be replaced
	const root = resolve(__dirname, '../../..');
	const built = { ...(parseJsonc(readFileSync(resolve(root, 'apps/admin/wrangler.json'), 'utf8')) as Record<string, unknown>), main: 'index.js', no_bundle: true };
	it.each(['qa', 'stage'])('%s binds its own stores and no production ones', (envName) => {
		const source = adminSource(root, envName);
		const out = deriveEnvConfig(built, source, envName);
		for (const key of ['name', 'vars', 'kv_namespaces', 'd1_databases', 'routes', 'observability', 'logpush']) expect(out[key], key).toEqual(source.env![envName]![key]);
		expect(out.d1_databases).toHaveLength(1);
		expect(out.main).toBe('index.js');
		expect(resourceIds(out)).toHaveLength(3); // KV, D1, host
	});

	it("refuses a config that still holds one of production's", () => {
		const d1 = (built as Record<string, unknown>).d1_databases;
		expect(() => deriveEnvConfig(built, { env: { qa: { name: 'qa', d1_databases: d1 } } }, 'qa')).toThrow(/production's .+, admin\.auth\.alummahnow\.net/);
		// a kind of binding the list does not know is kept, and so refused
		expect(() => deriveEnvConfig({ ...built, r2_buckets: [{ binding: 'R', bucket_name: 'prod-files' }] }, adminSource(root, 'qa'), 'qa')).toThrow('prod-files');
	});
});
