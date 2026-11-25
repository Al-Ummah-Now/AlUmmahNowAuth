import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminSource, deriveEnvConfig, resourceIds } from '../admin-config.ts';
import { parseJsonc } from '../jsonc.ts';
import { HOSTS, overrideHeader, REQUEST_TIMEOUT_MS, runSmoke, VERSION_PAUSE_MS, VERSION_WAIT_MS, type CheckResult } from '../smoke.ts';

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

/** A real server whose answers stall: no headers, or headers and half a body, then nothing. */
async function stalling(run: (url: string) => Promise<void>): Promise<void> {
	const server = createServer((req, res) => {
		if (req.url === '/body') res.writeHead(200, { 'Content-Type': 'application/json' }).write('{"status":');
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	try {
		await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
	} finally {
		server.closeAllConnections();
		server.close();
	}
}

describe('runSmoke', () => {
	afterEach(() => void vi.restoreAllMocks());

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
	});

	/** A clock that moves only when somebody sleeps. */
	const clock = () => {
		let t = 0;
		return { now: () => t, sleep: async (ms: number) => void (t += ms) };
	};
	const deepHealth = (results: CheckResult[]) => results.find((r) => r.name.startsWith('auth: deep health'))!;

	it('fails when the candidate never answers, after waiting as long as allowed and no longer', async () => {
		const c = clock();
		const stale = await runSmoke({ env: 'production', overrides: { 'al-ummah-now-auth': 'v-other' }, fetchImpl: fakeFetch(), ...c });
		expect(deepHealth(stale)).toMatchObject({ ok: false, detail: 'served by version v-new, expected candidate v-other (after 90 s)' });
		expect(c.now()).toBe(VERSION_WAIT_MS);
		expect(stale.filter((r) => !r.ok)).toHaveLength(1);
	});

	it('fails when overrides name no candidate of auth', async () => {
		const c = clock();
		const results = await runSmoke({ env: 'production', overrides: { 'al-ummah-now-profile': 'v-new' }, fetchImpl: fakeFetch(), ...c });
		expect(deepHealth(results)).toMatchObject({ ok: false, detail: 'no candidate version of al-ummah-now-auth given' });
		expect(c.now()).toBe(0);
	});

	it('gives every request a timeout, and one that stalls in any other check is a failure', async () => {
		for (const overrides of [undefined, { 'al-ummah-now-auth': 'v-new' }]) {
			const base = fakeFetch();
			for (const path of ['/.well-known/jwks.json', '/password/authorize', '/test/email/smoke%40e2e.alummahnow.net']) {
				const signals: unknown[] = [];
				const results = await runSmoke({
					env: 'production',
					overrides,
					requestTimeoutMs: 30,
					fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
						signals.push(init?.signal);
						if (new URL(String(input)).pathname !== path) return base(input, init);
						return new Promise((_, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason as Error)));
					}) as typeof fetch,
				});
				expect(signals.every((s) => s instanceof AbortSignal)).toBe(true);
				const failed = results.filter((r) => !r.ok);
				expect(failed.length, path).toBeGreaterThan(0);
				for (const f of failed) expect(f.detail, path).toMatch(/timeout/i);
			}
		}
	});

	it.each(['/headers', '/body'])('a stalled answer (%s) is not yet while the candidate is waited for, and a failure otherwise', async (path) => {
		await stalling(async (url) => {
			const base = fakeFetch();
			const run = async (overrides?: Record<string, string>) => {
				let n = 0;
				const results = await runSmoke({
					env: 'production',
					overrides,
					requestTimeoutMs: 50,
					sleep: async () => {},
					fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) =>
						new URL(String(input)).pathname === '/health' && n++ === 0 ? fetch(url + path, init) : base(input, init)) as typeof fetch,
				});
				return { health: deepHealth(results), asked: n };
			};
			expect(await run({ 'al-ummah-now-auth': 'v-new' })).toMatchObject({ health: { ok: true }, asked: 2 });
			expect(await run()).toMatchObject({ health: { ok: false, detail: expect.stringMatching(/timeout/i) }, asked: 1 });
		});
	});

	it('never waits past the deadline when every answer stalls', async () => {
		const c = clock();
		let t = 0;
		const timeouts: number[] = [];
		vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => (timeouts.push(ms), new AbortController().signal));
		const base = fakeFetch();
		const results = await runSmoke({
			env: 'production',
			overrides: { 'al-ummah-now-auth': 'v-new' },
			now: () => c.now() + t,
			sleep: c.sleep,
			fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
				if (new URL(String(input)).pathname !== '/health') return base(input, init);
				t += timeouts.at(-1)!;
				throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
			}) as typeof fetch,
		});
		expect(deepHealth(results)).toMatchObject({ ok: false, detail: 'no answer in time, expected candidate v-new (after 90 s)' });
		expect(c.now() + t).toBe(VERSION_WAIT_MS);
		expect(Math.max(...timeouts)).toBe(REQUEST_TIMEOUT_MS);
	});

	describe.each([
		['production', 'al-ummah-now-auth'],
		['stage', 'al-ummah-now-auth-stage'],
	] as const)('the version that answers on %s (release 45697039999)', (env, worker) => {
		const overrides = { [worker]: 'v-new' };
		/** Deep health answers with these in turn (the last one from then on); everything else is healthy. */
		const answering = (...answers: (() => Response)[]) => {
			let n = 0;
			const base = fakeFetch();
			const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = new URL(String(input));
				if (url.pathname === '/health') return answers[Math.min(n++, answers.length - 1)]();
				return base(input, init);
			}) as typeof fetch;
			return { fetchImpl, asked: () => n };
		};
		const says = (version: string | null, over: object = {}, status = 200) => () =>
			new Response(JSON.stringify({ status: 'ok', environment: env, version, checks: { d1: true }, ...over }), { status });

		it('waits for the candidate while an edge location still answers with the version before', async () => {
			const c = clock();
			const h = answering(says('v-old'), says(null), says('v-new'));
			const health = deepHealth(await runSmoke({ env, overrides, fetchImpl: h.fetchImpl, ...c }));
			expect(health).toMatchObject({ ok: true, detail: `env ${env}, version v-new (after ${(2 * VERSION_PAUSE_MS) / 1000} s)` });
			expect([h.asked(), c.now()]).toEqual([3, 2 * VERSION_PAUSE_MS]);
		});

		it('does not wait for an error, a status, a degraded answer or another environment, not even between tries', async () => {
			const bad: [string, () => Response, RegExp][] = [
				['status', says('v-new', {}, 500), /HTTP 500/],
				['degraded', says('v-new', { status: 'degraded', checks: { d1: false } }, 503), /degraded: d1/],
				['degraded, old version', says('v-old', { status: 'degraded', checks: { d1: false } }, 503), /degraded: d1/],
				['environment', says('v-new', { environment: 'qa' }), /environment is qa/],
				['not JSON', () => new Response('<html>'), /./],
				['network', () => { throw new TypeError('fetch failed'); }, /fetch failed/],
			];
			for (const [name, answer, detail] of bad) {
				const first = clock();
				const a = answering(answer, says('v-new'));
				const atOnce = deepHealth(await runSmoke({ env, overrides, fetchImpl: a.fetchImpl, ...first }));
				expect([atOnce.ok, a.asked(), first.now()], name).toEqual([false, 1, 0]);
				expect(atOnce.detail, name).toMatch(detail);
				const later = clock();
				const b = answering(says('v-old'), answer, says('v-new'));
				const afterOne = deepHealth(await runSmoke({ env, overrides, fetchImpl: b.fetchImpl, ...later }));
				expect([afterOne.ok, b.asked(), later.now()], name).toEqual([false, 2, VERSION_PAUSE_MS]);
				expect(afterOne.detail, name).toMatch(detail);
			}
		});

		it('asks once without overrides (after the promotion waitForVersion reads the version)', async () => {
			const c = clock();
			const h = answering(says('v-old'));
			expect(deepHealth(await runSmoke({ env, fetchImpl: h.fetchImpl, ...c }))).toMatchObject({ ok: true, detail: `env ${env}, version v-old` });
			expect([h.asked(), c.now()]).toEqual([1, 0]);
		});
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
