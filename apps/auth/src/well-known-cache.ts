/**
 * Edge cache for the public discovery documents.
 *
 * Every app verifies sign-ins with /.well-known/jwks.json, and OIDC clients read
 * /.well-known/openid-configuration. Served by the issuer, each request resolved
 * the tenant (`SELECT * FROM tenants`) and read the signing keys: on 2026-11-12
 * (21:00-22:15 UTC) production and stage D1 answered "D1 DB is overloaded.
 * Requests queued for too long" and these endpoints took 8-40 s, then 500'd.
 *
 * These documents are the same for every caller and change only when a signing
 * key is added (rare) or the issuer's configuration changes (a deploy). So:
 * - fresh copy: served from the colo's Cache API for FRESH_SECONDS, no D1/KV at all;
 * - miss: the issuer answers, a 200 is stored (fresh + last-good copies);
 * - issuer fails (5xx or throws): the last good copy (kept LAST_GOOD_SECONDS) is
 *   served instead, so a D1 stall cannot take token verification down.
 */

export const WELL_KNOWN_PATHS = new Set([
	'/.well-known/jwks.json',
	'/.well-known/openid-configuration',
	'/.well-known/oauth-authorization-server',
]);

/** How long a cached document is served without asking the issuer. */
export const FRESH_SECONDS = 300;
/** How long the last good document stays available for when the issuer fails. */
export const LAST_GOOD_SECONDS = 7 * 24 * 60 * 60;
/** What browsers and verifiers may cache (stale-if-error lets them ride out an outage too). */
export const PUBLIC_CACHE_CONTROL = `public, max-age=${FRESH_SECONDS}, stale-while-revalidate=60, stale-if-error=86400`;

/** Bump to drop every cached copy at once (shape change). */
const CACHE_VERSION = 'v1';

/**
 * A discovery request the edge cache serves. Local hosts (tests, the local stack)
 * always go to the issuer: each test database mints its own signing keys.
 */
export function isWellKnownRequest(method: string, url: URL): boolean {
	if (method !== 'GET' && method !== 'HEAD') return false;
	if (!WELL_KNOWN_PATHS.has(url.pathname)) return false;
	const host = url.hostname;
	return host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]' && !host.endsWith('.localhost');
}

function cacheKeys(url: URL): { fresh: Request; lastGood: Request } {
	// The query string is ignored by the issuer, so it is not part of the key (no cache busting)
	const base = `${url.origin}${url.pathname}`;
	return {
		fresh: new Request(`${base}?__wk=${CACHE_VERSION}-fresh`),
		lastGood: new Request(`${base}?__wk=${CACHE_VERSION}-last-good`),
	};
}

function stored(body: string, contentType: string, maxAge: number): Response {
	return new Response(body, {
		status: 200,
		headers: { 'Content-Type': contentType, 'Cache-Control': `public, max-age=${maxAge}` },
	});
}

function served(body: string | null, contentType: string, source: 'hit' | 'miss' | 'stale'): Response {
	return new Response(body, {
		status: 200,
		headers: {
			'Content-Type': contentType,
			'Cache-Control': PUBLIC_CACHE_CONTROL,
			'Access-Control-Allow-Origin': '*',
			'X-Well-Known-Cache': source,
		},
	});
}

interface WaitUntil {
	waitUntil(promise: Promise<unknown>): void;
}

/**
 * Serve a discovery document through the edge cache.
 * `origin` produces the issuer's response (called only on a miss).
 */
export async function serveWellKnown(
	request: Request,
	ctx: WaitUntil,
	origin: () => Promise<Response>,
	cache: Cache | undefined = (globalThis as { caches?: { default?: Cache } }).caches?.default
): Promise<Response> {
	const url = new URL(request.url);
	const head = request.method === 'HEAD';
	if (!cache) return origin();

	const keys = cacheKeys(url);
	const hit = await cache.match(keys.fresh).catch(() => undefined);
	if (hit) {
		const contentType = hit.headers.get('Content-Type') ?? 'application/json';
		return served(head ? null : await hit.text(), contentType, 'hit');
	}

	let response: Response | undefined;
	let failure: unknown;
	try {
		response = await origin();
	} catch (error) {
		failure = error;
	}

	if (response && response.status === 200) {
		const body = await response.text();
		const contentType = response.headers.get('Content-Type') ?? 'application/json';
		ctx.waitUntil(
			Promise.all([
				cache.put(keys.fresh, stored(body, contentType, FRESH_SECONDS)),
				cache.put(keys.lastGood, stored(body, contentType, LAST_GOOD_SECONDS)),
			]).catch(() => undefined)
		);
		return served(head ? null : body, contentType, 'miss');
	}

	// The issuer failed: the last good copy beats an error for a document this stable
	if (!response || response.status >= 500) {
		const lastGood = await cache.match(keys.lastGood).catch(() => undefined);
		if (lastGood) {
			const contentType = lastGood.headers.get('Content-Type') ?? 'application/json';
			return served(head ? null : await lastGood.text(), contentType, 'stale');
		}
	}

	if (response) return response;
	throw failure;
}
