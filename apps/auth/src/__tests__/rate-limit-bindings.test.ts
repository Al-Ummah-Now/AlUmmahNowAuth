/**
 * AU-1: every rate limit is a Workers Rate Limiting binding, keyed so that no
 * two users (or clients) share a bucket. The old KV limiter put every
 * first-party /token call on one key, lost increments under concurrency and
 * failed open on KV's 1-write-per-second limit.
 */
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import '../test-setup';
import worker from '../index';
import { withinRateLimit } from '../rate-limit';
import { rateLimit } from '../middleware/rate-limit';
import { fakeLimiter } from './helpers/fake-limiter';

const WORKER_IP = '2a06:98c0:3600::103';

const ctx = () =>
	({ waitUntil: (p: Promise<unknown>) => void p.catch(() => {}), passThroughOnException: () => {} }) as unknown as ExecutionContext;

function testEnv(extra: Record<string, unknown>): Env {
	return { ...(env as unknown as Env), ENVIRONMENT: 'development', OPENAUTH_ISSUER: 'http://localhost', ...extra } as unknown as Env;
}

function tokenRequest(fields: Record<string, string>, opts: { ip: string; worker?: string }) {
	const headers: Record<string, string> = {
		'Content-Type': 'application/x-www-form-urlencoded',
		'CF-Connecting-IP': opts.ip,
		Host: 'localhost',
	};
	if (opts.worker) headers['CF-Worker'] = opts.worker;
	return new Request('http://localhost/token', { method: 'POST', headers, body: new URLSearchParams(fields).toString() });
}

describe('withinRateLimit', () => {
	it('500 parallel calls on one key through the real (miniflare) binding: exactly its limit pass', async () => {
		const limiter = (env as unknown as { TEST_LIMITER: RateLimit }).TEST_LIMITER;
		const key = `parallel-${crypto.randomUUID()}`;
		const results = await Promise.all(Array.from({ length: 500 }, () => withinRateLimit(limiter, key)));
		expect(results.filter(Boolean).length).toBe(10);
	});

	it('keys are independent', async () => {
		const limiter = (env as unknown as { TEST_LIMITER: RateLimit }).TEST_LIMITER;
		const results = await Promise.all(Array.from({ length: 50 }, (_, i) => withinRateLimit(limiter, `independent-${crypto.randomUUID()}-${i}`)));
		expect(results.every(Boolean)).toBe(true);
	});

	it('allows when the binding is absent (local dev) or fails', async () => {
		expect(await withinRateLimit(undefined, 'k')).toBe(true);
		const broken = { limit: async () => { throw new Error('boom'); } } as unknown as RateLimit;
		expect(await withinRateLimit(broken, 'k')).toBe(true);
	});
});

describe('/token through the Worker', () => {
	it('300 parallel first-party refreshes for 300 users: none is refused by the limiter (no shared bucket)', async () => {
		const TOKEN_LIMITER = fakeLimiter(1);
		const TOKEN_CLIENT_LIMITER = fakeLimiter(1);
		const e = testEnv({ TOKEN_LIMITER, TOKEN_CLIENT_LIMITER });
		const statuses = await Promise.all(
			Array.from({ length: 300 }, (_, i) =>
				worker
					.fetch(
						tokenRequest(
							{ grant_type: 'refresh_token', refresh_token: `user:load-${i}:00000000-0000-0000-0000-000000000000`, client_id: 'profile' },
							{ ip: WORKER_IP, worker: 'alummahnow.net' }
						),
						e,
						ctx()
					)
					.then((r) => r.status)
			)
		);
		expect(statuses.filter((s) => s === 429).length).toBe(0);
		expect(TOKEN_LIMITER.counts.size).toBe(300);
		expect(TOKEN_CLIENT_LIMITER.counts.size).toBe(0);
	});

	it('one user over the limit gets 429 with Retry-After; another user is unaffected', async () => {
		const TOKEN_LIMITER = fakeLimiter(2);
		const e = testEnv({ TOKEN_LIMITER, TOKEN_CLIENT_LIMITER: fakeLimiter(100) });
		const refresh = (user: string) =>
			worker.fetch(
				tokenRequest({ grant_type: 'refresh_token', refresh_token: `user:${user}:tok`, client_id: 'profile' }, { ip: WORKER_IP, worker: 'alummahnow.net' }),
				e,
				ctx()
			);
		const statuses = [];
		for (let i = 0; i < 3; i++) statuses.push((await refresh('busy')).status);
		expect(statuses.slice(0, 2)).not.toContain(429);
		const refused = await refresh('busy');
		expect(refused.status).toBe(429);
		expect(refused.headers.get('Retry-After')).toBe('60');
		expect((await refresh('calm')).status).not.toBe(429);
	});

	it("an outside caller naming a victim's subject spends only its own IP's bucket", async () => {
		const TOKEN_LIMITER = fakeLimiter(3);
		const e = testEnv({ TOKEN_LIMITER, TOKEN_CLIENT_LIMITER: fakeLimiter(100) });
		const forged = await Promise.all(
			Array.from({ length: 50 }, (_, i) =>
				worker
					.fetch(tokenRequest({ grant_type: 'refresh_token', refresh_token: `user:victim:forged-${i}`, client_id: 'native' }, { ip: '198.51.100.66' }), e, ctx())
					.then((r) => r.status)
			)
		);
		expect(forged.filter((s) => s === 429).length).toBe(47);
		expect([...TOKEN_LIMITER.counts.keys()]).toEqual(['/token:ip:198.51.100.66']);
		// The victim's own refresh, through profile, is untouched
		const victim = await worker.fetch(
			tokenRequest({ grant_type: 'refresh_token', refresh_token: 'user:victim:real', client_id: 'profile' }, { ip: WORKER_IP, worker: 'alummahnow.net' }),
			e,
			ctx()
		);
		expect(victim.status).not.toBe(429);
	});

	it("our Workers' code exchanges count per client; outside callers per IP", async () => {
		const TOKEN_LIMITER = fakeLimiter(100);
		const TOKEN_CLIENT_LIMITER = fakeLimiter(100);
		const e = testEnv({ TOKEN_LIMITER, TOKEN_CLIENT_LIMITER });
		await worker.fetch(tokenRequest({ grant_type: 'authorization_code', code: 'x', client_id: 'profile' }, { ip: WORKER_IP, worker: 'alummahnow.net' }), e, ctx());
		await worker.fetch(tokenRequest({ grant_type: 'authorization_code', code: 'x', client_id: 'native' }, { ip: '198.51.100.20' }), e, ctx());
		expect([...TOKEN_CLIENT_LIMITER.counts.keys()]).toEqual(['/token:client:profile']);
		expect([...TOKEN_LIMITER.counts.keys()]).toEqual(['/token:ip:198.51.100.20']);
	});
});

describe('AD-2: cold admin isolates fetching their M2M token', () => {
	it('200 client_credentials calls from the admin Worker count on its own client bucket, not per IP or a shared key', async () => {
		const TOKEN_LIMITER = fakeLimiter(1);
		const TOKEN_CLIENT_LIMITER = fakeLimiter(3000);
		const e = testEnv({ TOKEN_LIMITER, TOKEN_CLIENT_LIMITER });
		const statuses = await Promise.all(
			Array.from({ length: 200 }, () =>
				worker
					.fetch(
						tokenRequest({ grant_type: 'client_credentials', client_id: 'admin-m2m', client_secret: 'x' }, { ip: WORKER_IP, worker: 'alummahnow.net' }),
						e,
						ctx()
					)
					.then((r) => r.status)
			)
		);
		expect(statuses.filter((s) => s === 429)).toHaveLength(0);
		expect([...TOKEN_CLIENT_LIMITER.counts.entries()]).toEqual([['/token:client:admin-m2m', 200]]);
		expect(TOKEN_LIMITER.counts.size).toBe(0);
	});
});

describe('admin rate limit middleware', () => {
	function app() {
		const a = new Hono<{ Bindings: Env; Variables: { adminUser?: { userId: string } } }>();
		a.use('*', async (c, next) => {
			const user = c.req.header('X-Test-Admin');
			if (user) c.set('adminUser', { userId: user });
			await next();
		});
		a.get('/view', rateLimit({ keyPrefix: 'admin:view' }), (c) => c.text('ok'));
		a.post('/terminate', rateLimit({ keyPrefix: 'admin:terminate', sensitive: true }), (c) => c.text('ok'));
		return a;
	}

	it('counts per acting admin, on the sensitive limiter for destructive actions', async () => {
		const ADMIN_LIMITER = fakeLimiter(2);
		const ADMIN_SENSITIVE_LIMITER = fakeLimiter(1);
		const e = { ADMIN_LIMITER, ADMIN_SENSITIVE_LIMITER } as unknown as Env;
		const get = (admin: string) => app().request('/view', { headers: { 'X-Test-Admin': admin, 'CF-Connecting-IP': WORKER_IP } }, e);
		expect((await get('a1')).status).toBe(200);
		expect((await get('a1')).status).toBe(200);
		const third = await get('a1');
		expect(third.status).toBe(429);
		expect(third.headers.get('Retry-After')).toBe('60');
		expect((await get('a2')).status).toBe(200); // same egress IP, different admin
		const del = () => app().request('/terminate', { method: 'POST', headers: { 'X-Test-Admin': 'a1' } }, e);
		expect((await del()).status).toBe(200);
		expect((await del()).status).toBe(429);
		expect([...ADMIN_SENSITIVE_LIMITER.counts.keys()]).toEqual(['admin:terminate:user:a1']);
	});

	it('falls back to the client IP without an admin context', async () => {
		const ADMIN_LIMITER = fakeLimiter(5);
		await app().request('/view', { headers: { 'CF-Connecting-IP': '198.51.100.30' } }, { ADMIN_LIMITER } as unknown as Env);
		expect([...ADMIN_LIMITER.counts.keys()]).toEqual(['admin:view:ip:198.51.100.30']);
	});
});
