/**
 * Release smoke checks (SPEC §7.3): fast, no sign-up, safe against production.
 *
 *   node --experimental-strip-types scripts/release/smoke.ts --env stage
 *   node --experimental-strip-types scripts/release/smoke.ts --env production \
 *     --override al-ummah-now-auth=<version-id>     # pre-traffic: hit the candidate version
 *
 * With --override, every request carries Cloudflare-Workers-Version-Overrides, so
 * the checks run on that (0%-traffic) version with production bindings. Auth deep
 * health says which version answered; every other check sends X-Release-Check and
 * counts only when its Worker's candidate answered all its requests
 * (packages/ui/src/release-check.ts). Another version's answer is asked for again,
 * up to VERSION_WAIT_MS for the whole smoke. Without --override every check asks once.
 */
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { RELEASE_CHECK_HEADER, RELEASE_CHECK_OK } from '../../packages/ui/src/release-check.ts';

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
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	/** How long one request may take (tests) */
	requestTimeoutMs?: number;
}

/** How long the whole smoke may wait for answers of the candidates instead of another version, and the pause between tries. */
export const VERSION_WAIT_MS = 90_000;
export const VERSION_PAUSE_MS = 5_000;

/** One request may take this long (a stalled one must not outlive the waits around it). */
export const REQUEST_TIMEOUT_MS = 15_000;
export const isTimeout = (error: unknown): boolean => (error as Error)?.name === 'TimeoutError';

/** The Workers' names, without the env's suffix. */
const WORKERS = { auth: 'al-ummah-now-auth', profile: 'al-ummah-now-profile', admin: 'al-ummah-now-auth-admin' } as const;
export const workerName = (env: SmokeEnv, app: keyof typeof WORKERS): string => (env === 'production' ? WORKERS[app] : `${WORKERS[app]}-${env}`);

export function overrideHeader(overrides: Record<string, string>): string {
	return Object.entries(overrides)
		.map(([worker, version]) => `${worker}="${version}"`)
		.join(', ');
}

export async function runSmoke(opts: SmokeOptions): Promise<CheckResult[]> {
	const hosts = HOSTS[opts.env];
	const doFetch = opts.fetchImpl ?? fetch;
	const now = opts.now ?? Date.now;
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const headers: Record<string, string> = { 'User-Agent': 'al-ummah-now-release-smoke' };
	if (opts.overrides && Object.keys(opts.overrides).length) headers['Cloudflare-Workers-Version-Overrides'] = overrideHeader(opts.overrides);
	const requestTimeout = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
	const get = (url: string, init: RequestInit = {}, timeoutMs = requestTimeout) =>
		doFetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), ...init, headers: { ...headers, ...(init.headers as Record<string, string>) } });

	const results: CheckResult[] = [];
	// One deadline for the whole smoke: a mixed edge is mixed for all checks alike
	const deadline = now() + VERSION_WAIT_MS;
	const started = now();
	const timeLeft = () => Math.min(requestTimeout, Math.max(VERSION_PAUSE_MS, deadline - now()));
	const waited = () => Math.round((now() - started) / 1000);
	type Get = (url: string, init?: RequestInit) => Promise<Response>;

	/**
	 * A check of `app`'s Worker. With a candidate of it, the verdict counts only when the candidate answered every
	 * request of the check; otherwise (an older version, an edge error page, a stalled request) the whole check runs
	 * again until the deadline. A verdict of the candidate, pass or fail, and a failed connection end it at once.
	 */
	const check = async (name: string, app: keyof typeof WORKERS, fn: (get: Get) => Promise<string>) => {
		const worker = workerName(opts.env, app);
		const wanted = opts.overrides?.[worker];
		for (let tries = 1; ; tries++) {
			const proven: boolean[] = [];
			let broken = false;
			const ask: Get = async (url, init = {}) => {
				try {
					const asked = wanted ? { ...init, headers: { ...(init.headers as Record<string, string>), [RELEASE_CHECK_HEADER]: wanted } } : init;
					const res = await get(url, asked, wanted ? timeLeft() : requestTimeout);
					proven.push(res.headers.get(RELEASE_CHECK_HEADER) === RELEASE_CHECK_OK);
					return res;
				} catch (error) {
					broken = broken || !isTimeout(error);
					throw error;
				}
			};
			let result: CheckResult;
			let stalled = false;
			try {
				result = { name, ok: true, detail: await fn(ask) };
			} catch (error) {
				stalled = isTimeout(error);
				result = { name, ok: false, detail: (error as Error).message };
			}
			const answeredByCandidate = proven.length > 0 && proven.every(Boolean) && !stalled;
			if (!wanted || broken || answeredByCandidate) {
				if (wanted && tries > 1 && result.ok) result.detail += ` (after ${waited()} s)`;
				results.push(result);
				return;
			}
			if (now() + VERSION_PAUSE_MS > deadline) {
				const last = stalled ? 'no answer in time' : `last answer, of another version: ${result.detail}`;
				results.push({ name, ok: false, detail: `not answered by candidate ${wanted} of ${worker} (after ${waited()} s; ${last})` });
				return;
			}
			await sleep(VERSION_PAUSE_MS);
		}
	};
	const assert = (cond: unknown, msg: string) => {
		if (!cond) throw new Error(msg);
	};

	await check('auth: issuer metadata', 'auth', async (get) => {
		const res = await get(`${hosts.auth}/.well-known/oauth-authorization-server`);
		assert(res.status === 200, `HTTP ${res.status}`);
		const meta = (await res.json()) as Record<string, string>;
		assert(meta.issuer === hosts.auth, `issuer is ${meta.issuer}, expected ${hosts.auth}`);
		for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
			assert(new URL(meta[key]).origin === hosts.auth, `${key} is ${meta[key]}`);
		}
		return `issuer ${meta.issuer}`;
	});

	await check('auth: JWKS', 'auth', async (get) => {
		const res = await get(`${hosts.auth}/.well-known/jwks.json`);
		assert(res.status === 200, `HTTP ${res.status}`);
		const keys = ((await res.json()) as { keys?: unknown[] }).keys ?? [];
		assert(keys.length > 0, 'no signing keys');
		return `${keys.length} key(s)`;
	});

	// Says which version answered in its body, the same rule otherwise
	const health = 'auth: deep health (bindings resolve)';
	try {
		const worker = workerName(opts.env, 'auth');
		const wanted = opts.overrides?.[worker];
		// With overrides the candidate itself has to answer: no version to ask for is no proof
		assert(wanted || !Object.keys(opts.overrides ?? {}).length, `no candidate version of ${worker} given`);
		for (;;) {
			let served: string;
			try {
				const res = await get(`${hosts.auth}/health?deep=1`, {}, wanted ? timeLeft() : requestTimeout);
				const body = (await res.json()) as { status: string; environment: string; version: string | null; checks: Record<string, boolean> };
				const failed = Object.entries(body.checks ?? {})
					.filter(([, ok]) => !ok)
					.map(([k]) => k);
				assert(res.status === 200 && body.status === 'ok', `degraded: ${failed.join(', ') || `HTTP ${res.status}`}`);
				assert(body.environment === opts.env, `environment is ${body.environment}, expected ${opts.env}`);
				if (!wanted || body.version === wanted) {
					results.push({ name: health, ok: true, detail: `env ${body.environment}, version ${body.version ?? 'unknown'}${waited() >= 1 && wanted ? ` (after ${waited()} s)` : ''}` });
					break;
				}
				served = `served by version ${body.version}`;
			} catch (error) {
				// A request that stalls says nothing about the candidate yet
				if (!wanted || !isTimeout(error)) throw error;
				served = 'no answer in time';
			}
			// Edge locations learn of a new deployment at different times: one can still answer with the version
			// before it, after waitForVersion saw the candidate. Only that (and a stalled request) is waited for: an
			// error, another status or a degraded answer fails above, at once, on every try.
			assert(now() + VERSION_PAUSE_MS <= deadline, `${served}, expected candidate ${wanted} (after ${waited()} s)`);
			await sleep(VERSION_PAUSE_MS);
		}
	} catch (error) {
		results.push({ name: health, ok: false, detail: (error as Error).message });
	}

	await check('auth: test routes are not reachable without the secret', 'auth', async (get) => {
		const res = await get(`${hosts.auth}/test/email/smoke%40e2e.alummahnow.net`, { headers: { 'X-E2E-Secret': 'not-the-secret' } });
		assert(res.status === 404, `HTTP ${res.status}`);
		return '404';
	});

	for (const client of CLIENTS[opts.env]) {
		await check(`auth: authorize renders sign-in for ${client.name}`, 'auth', async (get) => {
			const url = new URL(`${hosts.auth}/authorize`);
			url.searchParams.set('client_id', client.id);
			url.searchParams.set('redirect_uri', client.redirect(hosts));
			url.searchParams.set('response_type', 'code');
			url.searchParams.set('state', 'release-smoke');
			// Public clients must send PKCE S256 (#211); a fixed, well-formed challenge
			url.searchParams.set('code_challenge', 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
			url.searchParams.set('code_challenge_method', 'S256');
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

	for (const [name, app, base] of [
		['profile', 'profile', hosts.profile],
		['auth admin', 'admin', hosts.admin],
	] as const) {
		await check(`${name}: home page`, app, async (get) => {
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

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
	const opts = parseArgs(process.argv.slice(2));
	const results = await runSmoke(opts);
	for (const r of results) process.stdout.write(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}: ${r.detail}\n`);
	const failed = results.filter((r) => !r.ok);
	process.stdout.write(`\n${results.length - failed.length}/${results.length} smoke checks passed (${opts.env}).\n`);
	if (failed.length) process.exit(1);
}
