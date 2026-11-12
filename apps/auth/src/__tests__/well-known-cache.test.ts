import { describe, it, expect, vi, beforeEach } from 'vitest';
import { serveWellKnown, isWellKnownRequest, PUBLIC_CACHE_CONTROL } from '../well-known-cache';
import { cachedTenant, clearTenantCache } from '../services/tenant-cache';

/** An in-memory stand-in for the Cache API (keyed by URL). */
function fakeCache() {
	const store = new Map<string, Response>();
	const cache = {
		match: vi.fn(async (req: Request) => store.get(req.url)?.clone()),
		put: vi.fn(async (req: Request, res: Response) => {
			store.set(req.url, res.clone());
		}),
	};
	return { cache: cache as unknown as Cache, store, spy: cache };
}

function ctx() {
	const pending: Promise<unknown>[] = [];
	return { waitUntil: (p: Promise<unknown>) => void pending.push(p), settle: () => Promise.all(pending) };
}

const JWKS = 'https://auth.example.test/.well-known/jwks.json';
const body = JSON.stringify({ keys: [{ kid: 'k1', kty: 'EC' }] });
const ok = () => new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });

describe('well-known edge cache', () => {
	it('only handles GET/HEAD of the discovery paths', () => {
		const at = (path: string, host = 'auth.alummahnow.net') => new URL(`https://${host}${path}`);
		expect(isWellKnownRequest('GET', at('/.well-known/jwks.json'))).toBe(true);
		expect(isWellKnownRequest('HEAD', at('/.well-known/openid-configuration'))).toBe(true);
		expect(isWellKnownRequest('GET', at('/.well-known/oauth-authorization-server'))).toBe(true);
		expect(isWellKnownRequest('POST', at('/.well-known/jwks.json'))).toBe(false);
		expect(isWellKnownRequest('GET', at('/token'))).toBe(false);
		// Tests and the local stack mint their own keys: never cached
		expect(isWellKnownRequest('GET', at('/.well-known/jwks.json', 'localhost'))).toBe(false);
		expect(isWellKnownRequest('GET', at('/.well-known/jwks.json', '127.0.0.1'))).toBe(false);
	});

	it('a miss asks the issuer once, then serves the cached copy without it', async () => {
		const { cache } = fakeCache();
		const origin = vi.fn(async () => ok());
		const c1 = ctx();
		const first = await serveWellKnown(new Request(JWKS), c1, origin, cache);
		await c1.settle();
		expect(first.status).toBe(200);
		expect(first.headers.get('X-Well-Known-Cache')).toBe('miss');
		expect(first.headers.get('Cache-Control')).toBe(PUBLIC_CACHE_CONTROL);
		expect(await first.text()).toBe(body);

		// A query string does not bust the cache
		const second = await serveWellKnown(new Request(`${JWKS}?bust=1`), ctx(), origin, cache);
		expect(second.headers.get('X-Well-Known-Cache')).toBe('hit');
		expect(await second.text()).toBe(body);
		expect(origin).toHaveBeenCalledTimes(1);
	});

	it('serves the last good copy when the issuer 500s or throws (D1 overloaded)', async () => {
		const { cache, store } = fakeCache();
		const c1 = ctx();
		await serveWellKnown(new Request(JWKS), c1, async () => ok(), cache);
		await c1.settle();
		// The fresh copy expires; the long-lived last-good copy remains
		for (const key of [...store.keys()]) if (key.includes('-fresh')) store.delete(key);

		const failing = await serveWellKnown(
			new Request(JWKS),
			ctx(),
			async () => new Response('{"error":"server_error"}', { status: 500 }),
			cache
		);
		expect(failing.status).toBe(200);
		expect(failing.headers.get('X-Well-Known-Cache')).toBe('stale');
		expect(await failing.text()).toBe(body);

		const throwing = await serveWellKnown(
			new Request(JWKS),
			ctx(),
			async () => {
				throw new Error('D1_ERROR: D1 DB is overloaded');
			},
			cache
		);
		expect(throwing.status).toBe(200);
		expect(await throwing.text()).toBe(body);
	});

	it('passes errors through when there is no good copy, and never caches them', async () => {
		const { cache, spy } = fakeCache();
		const res = await serveWellKnown(new Request(JWKS), ctx(), async () => new Response('x', { status: 500 }), cache);
		expect(res.status).toBe(500);
		expect(spy.put).not.toHaveBeenCalled();
	});

	it('HEAD gets headers only, and the cached body stays whole', async () => {
		const { cache } = fakeCache();
		const c1 = ctx();
		const head = await serveWellKnown(new Request(JWKS, { method: 'HEAD' }), c1, async () => ok(), cache);
		await c1.settle();
		expect(head.status).toBe(200);
		expect(await head.text()).toBe('');
		const get = await serveWellKnown(new Request(JWKS), ctx(), async () => ok(), cache);
		expect(await get.text()).toBe(body);
	});
});

describe('tenant cache when D1 fails', () => {
	beforeEach(() => {
		clearTenantCache();
		vi.useRealTimers();
	});

	it('serves the last tenant read within the hour instead of failing', async () => {
		vi.useFakeTimers();
		const tenant = { id: 'default' } as never;
		await cachedTenant('id:default', async () => tenant);
		vi.advanceTimersByTime(5 * 60_000); // past the 60 s TTL
		const again = await cachedTenant('id:default', async () => {
			throw new Error('D1_ERROR: D1 DB is overloaded. Requests queued for too long.');
		});
		expect(again).toBe(tenant);
		vi.useRealTimers();
	});

	it('still throws when nothing was read (or the copy is over an hour old)', async () => {
		vi.useFakeTimers();
		const boom = async () => {
			throw new Error('overloaded');
		};
		await expect(cachedTenant('id:none', boom)).rejects.toThrow('overloaded');
		await cachedTenant('id:old', async () => ({ id: 'old' }) as never);
		vi.advanceTimersByTime(61 * 60_000);
		await expect(cachedTenant('id:old', boom)).rejects.toThrow('overloaded');
		vi.useRealTimers();
	});
});
