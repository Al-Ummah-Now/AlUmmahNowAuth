/**
 * Release smoke checks (SPEC §7.3): fast, no sign-up, safe against production.
 *
 *   node --experimental-strip-types scripts/release/smoke.ts --env stage
 *   node --experimental-strip-types scripts/release/smoke.ts --env production \
 *     --override al-ummah-now-auth=<version-id>     # pre-traffic: hit the candidate version
 *
 * With --override, every request carries Cloudflare-Workers-Version-Overrides, so
 * the checks run on that (0%-traffic) version with production bindings, and the
 * auth deep-health check asserts the response came from it.
 */
import { resolve } from 'node:path';

export type SmokeEnv = 'qa' | 'stage' | 'production';

export const HOSTS: Record<SmokeEnv, { auth: string; profile: string; admin: string; web: string }> = {
	qa: {
		auth: 'https://auth.qa.alummahnow.net',
		profile: 'https://profile.auth.qa.alummahnow.net',
		admin: 'https://admin.auth.qa.alummahnow.net',
		web: 'https://videos.qa.alummahnow.net',
	},
	stage: {
		auth: 'https://auth.stage.alummahnow.net',
		profile: 'https://profile.auth.stage.alummahnow.net',
		admin: 'https://admin.auth.stage.alummahnow.net',
		web: 'https://videos.stage.alummahnow.net',
	},
	production: {
		auth: 'https://auth.alummahnow.net',
		profile: 'https://profile.auth.alummahnow.net',
		admin: 'https://admin.auth.alummahnow.net',
		web: 'https://videos.alummahnow.net',
	},
};

type Hosts = (typeof HOSTS)['stage'];

/** Clients whose authorize request must render the sign-in form (not an error). */
export const CLIENTS: Record<SmokeEnv, { name: string; id: string; redirect: (h: Hosts) => string }[]> = {
	production: [
		{ name: 'profile', id: '109a1087-6626-40f7-8a7f-7f42f83f4f30', redirect: (h) => `${h.profile}/callback` },
		{ name: 'auth admin', id: '1448ed27-39a6-417d-b4c8-07f881e81269', redirect: (h) => `${h.admin}/auth/callback` },
		{ name: 'web', id: 'f0de3c30-0304-4ac4-86d6-1e185dec0439', redirect: (h) => `${h.web}/api/callback` },
	],
	qa: [
		{ name: 'profile', id: '109a1087-6626-40f7-8a7f-7f42f83f4f30', redirect: (h) => `${h.profile}/callback` },
		{ name: 'auth admin', id: '2448ed27-39a6-417d-b4c8-07f881e81269', redirect: (h) => `${h.admin}/auth/callback` },
		{ name: 'web', id: 'e0de3c30-0304-4ac4-86d6-1e185dec0439', redirect: (h) => `${h.web}/api/callback` },
	],
	stage: [],
};
// Stage mirrors prod's clients (same ids, stage hosts): scripts/stage/seed.ts
CLIENTS.stage = CLIENTS.production;

export interface CheckResult {
	name: string;
	ok: boolean;
	detail: string;
}

export interface SmokeOptions {
	env: SmokeEnv;
	/** worker name → version id */
	overrides?: Record<string, string>;
	fetchImpl?: typeof fetch;
}

export function overrideHeader(overrides: Record<string, string>): string {
	return Object.entries(overrides)
		.map(([worker, version]) => `${worker}="${version}"`)
		.join(', ');
}

export async function runSmoke(opts: SmokeOptions): Promise<CheckResult[]> {
	const hosts = HOSTS[opts.env];
	const doFetch = opts.fetchImpl ?? fetch;
	const headers: Record<string, string> = { 'User-Agent': 'al-ummah-now-release-smoke' };
	if (opts.overrides && Object.keys(opts.overrides).length) headers['Cloudflare-Workers-Version-Overrides'] = overrideHeader(opts.overrides);
	const get = (url: string, init: RequestInit = {}) =>
		doFetch(url, { redirect: 'manual', ...init, headers: { ...headers, ...(init.headers as Record<string, string>) } });

	const results: CheckResult[] = [];
	const check = async (name: string, fn: () => Promise<string>) => {
		try {
			results.push({ name, ok: true, detail: await fn() });
		} catch (error) {
			results.push({ name, ok: false, detail: (error as Error).message });
		}
	};
	const assert = (cond: unknown, msg: string) => {
		if (!cond) throw new Error(msg);
	};

	await check('auth: issuer metadata', async () => {
		const res = await get(`${hosts.auth}/.well-known/oauth-authorization-server`);
		assert(res.status === 200, `HTTP ${res.status}`);
		const meta = (await res.json()) as Record<string, string>;
		assert(meta.issuer === hosts.auth, `issuer is ${meta.issuer}, expected ${hosts.auth}`);
		for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
			assert(new URL(meta[key]).origin === hosts.auth, `${key} is ${meta[key]}`);
		}
		return `issuer ${meta.issuer}`;
	});

	await check('auth: JWKS', async () => {
		const res = await get(`${hosts.auth}/.well-known/jwks.json`);
		assert(res.status === 200, `HTTP ${res.status}`);
		const keys = ((await res.json()) as { keys?: unknown[] }).keys ?? [];
		assert(keys.length > 0, 'no signing keys');
		return `${keys.length} key(s)`;
	});

	await check('auth: deep health (bindings resolve)', async () => {
		const res = await get(`${hosts.auth}/health?deep=1`);
		const body = (await res.json()) as { status: string; environment: string; version: string | null; checks: Record<string, boolean> };
		const failed = Object.entries(body.checks ?? {})
			.filter(([, ok]) => !ok)
			.map(([k]) => k);
		assert(res.status === 200 && body.status === 'ok', `degraded: ${failed.join(', ') || `HTTP ${res.status}`}`);
		assert(body.environment === opts.env, `environment is ${body.environment}, expected ${opts.env}`);
		const wanted = opts.overrides?.[opts.env === 'production' ? 'al-ummah-now-auth' : `al-ummah-now-auth-${opts.env}`];
		if (wanted) assert(body.version === wanted, `served by version ${body.version}, expected candidate ${wanted}`);
		return `env ${body.environment}, version ${body.version ?? 'unknown'}`;
	});

	await check('auth: test routes are not reachable without the secret', async () => {
		const res = await get(`${hosts.auth}/test/email/smoke%40e2e.alummahnow.net`, { headers: { 'X-E2E-Secret': 'not-the-secret' } });
		assert(res.status === 404, `HTTP ${res.status}`);
		return '404';
	});

	for (const client of CLIENTS[opts.env]) {
		await check(`auth: authorize renders sign-in for ${client.name}`, async () => {
			const url = new URL(`${hosts.auth}/authorize`);
			url.searchParams.set('client_id', client.id);
			url.searchParams.set('redirect_uri', client.redirect(hosts));
			url.searchParams.set('response_type', 'code');
			url.searchParams.set('state', 'release-smoke');
			// Follow auth-server redirects (carrying cookies) to the page a user would see
			let res = await get(url.toString());
			let current = url;
			const cookies: string[] = [];
			for (let hop = 0; hop < 5 && res.status >= 300 && res.status < 400; hop++) {
				const location = res.headers.get('location') ?? '';
				const next = new URL(location, current);
				assert(next.origin === hosts.auth, `redirected off the auth server: ${next}`);
				assert(!next.searchParams.has('error'), `redirected with an error: ${next}`);
				for (const c of res.headers.getSetCookie?.() ?? []) cookies.push(c.split(';')[0]);
				current = next;
				res = await get(next.toString(), { headers: cookies.length ? { Cookie: cookies.join('; ') } : {} });
			}
			assert(res.status === 200, `HTTP ${res.status} at ${current.pathname}`);
			const html = await res.text();
			assert(/<form[\s>]/i.test(html) && /type="email"|name="email"/i.test(html), `no sign-in form at ${current.pathname}`);
			return `sign-in form at ${current.pathname}`;
		});
	}

	for (const [name, base] of [
		['profile', hosts.profile],
		['auth admin', hosts.admin],
	] as const) {
		await check(`${name}: home page`, async () => {
			const res = await get(`${base}/`);
			assert(res.status >= 200 && res.status < 400, `HTTP ${res.status}`);
			return `HTTP ${res.status}`;
		});
	}

	return results;
}

function parseArgs(argv: string[]): SmokeOptions {
	const opts: SmokeOptions = { env: 'stage', overrides: {} };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--env') opts.env = argv[++i] as SmokeEnv;
		else if (argv[i] === '--override') {
			const [worker, version] = argv[++i].split('=');
			opts.overrides![worker] = version;
		}
	}
	if (!(opts.env in HOSTS)) throw new Error(`unknown --env ${opts.env}`);
	return opts;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isMain) {
	const opts = parseArgs(process.argv.slice(2));
	const results = await runSmoke(opts);
	for (const r of results) process.stdout.write(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}: ${r.detail}\n`);
	const failed = results.filter((r) => !r.ok);
	process.stdout.write(`\n${results.length - failed.length}/${results.length} smoke checks passed (${opts.env}).\n`);
	if (failed.length) process.exit(1);
}
