/**
 * Picks the rate-limit buckets for a token-endpoint request (AU-1).
 *
 * Profile, admin, videos, www and cms exchange codes and refresh tokens
 * server-side, from Workers. Cloudflare gives those subrequests a shared Workers
 * egress address as CF-Connecting-IP, so a per-IP bucket would put every user of
 * those apps in one bucket (found on stage, 2026-11-08), and one shared key for
 * all of them was the AU-1 outage risk. So:
 * - our own Workers' refresh grants are counted per user (the subject in the
 *   refresh token). Those Workers send refresh tokens from their server-side
 *   session stores, never one a browser supplied, so the subject is real;
 * - our own Workers' other grants (code exchange, client_credentials,
 *   introspection, revocation) are counted per client_id, on a larger limiter;
 * - every other caller is counted per client IP, refreshes included: the
 *   subject in a refresh token nobody has checked yet is attacker-chosen, so
 *   keying on it would let a caller rotate subjects to dodge the limit, or name
 *   a victim's subject to use up the victim's refreshes.
 */

/** Zones whose Workers are first-party clients (CF-Worker carries the zone name). */
export const FIRST_PARTY_WORKER_ZONES: readonly string[] = ['alummahnow.net'];

/**
 * Cloudflare's IPv6 range that Workers subrequests egress from (2a06:98c0::/29).
 * CF-Connecting-IP is the real TCP peer, so a client outside Cloudflare cannot
 * present an address in this range, even if it sets a CF-Worker header.
 */
function isCloudflareWorkersEgress(ip: string): boolean {
	const first = ip.toLowerCase().split(':');
	if (first.length < 3 || first[0] !== '2a06') return false;
	const second = parseInt(first[1] || '0', 16);
	// /29 → the top 13 bits of the second hextet match 0x98c0
	return (second & 0xfff8) === 0x98c0;
}

/** True for a server-side request from one of our own Workers. */
export function isFirstPartyWorker(request: Request, clientIP: string): boolean {
	const zone = request.headers.get('CF-Worker')?.toLowerCase();
	return !!zone && FIRST_PARTY_WORKER_ZONES.includes(zone) && isCloudflareWorkersEgress(clientIP);
}

export interface TokenRateLimitBucket {
	/** TOKEN_LIMITER ('user') or TOKEN_CLIENT_LIMITER ('client') */
	limiter: 'user' | 'client';
	key: string;
}

/** Fields of a token-endpoint request that pick its buckets. */
export interface TokenRequestFields {
	grantType?: string;
	refreshToken?: string;
	clientId?: string;
}

/** Reads grant_type, refresh_token and client_id (body or Basic auth) without consuming the request. */
export async function readTokenRequestFields(request: Request): Promise<TokenRequestFields> {
	const out: TokenRequestFields = {};
	const auth = request.headers.get('Authorization');
	if (auth?.startsWith('Basic ')) {
		try {
			const decoded = atob(auth.slice(6));
			const id = decoded.slice(0, decoded.indexOf(':'));
			if (id) out.clientId = decodeURIComponent(id);
		} catch {
			// not Basic credentials; ignore
		}
	}
	const type = request.headers.get('Content-Type') ?? '';
	try {
		if (type.includes('application/x-www-form-urlencoded') || type.includes('multipart/form-data')) {
			const form = await request.clone().formData();
			out.grantType = form.get('grant_type')?.toString();
			out.refreshToken = form.get('refresh_token')?.toString() ?? form.get('token')?.toString();
			out.clientId ??= form.get('client_id')?.toString();
		} else if (type.includes('application/json')) {
			const body = (await request.clone().json()) as Record<string, unknown>;
			if (typeof body.grant_type === 'string') out.grantType = body.grant_type;
			const token = body.refresh_token ?? body.token;
			if (typeof token === 'string') out.refreshToken = token;
			if (!out.clientId && typeof body.client_id === 'string') out.clientId = body.client_id;
		}
	} catch {
		// unreadable body: the issuer rejects it; count it per IP
	}
	return out;
}

/** The subject of an OpenAuth refresh token (`<subject>:<id>`), or undefined. */
export function refreshTokenSubject(token: string | undefined): string | undefined {
	if (!token) return undefined;
	const i = token.lastIndexOf(':');
	if (i <= 0 || i > 512) return undefined;
	return token.slice(0, i);
}

export function tokenRateLimitBuckets(
	request: Request,
	pathname: string,
	clientIP: string,
	fields: TokenRequestFields
): TokenRateLimitBucket[] {
	if (isFirstPartyWorker(request, clientIP)) {
		// Every user of a server-side app shares its egress address, so refreshes
		// are per user; the token comes from the app's own session store
		const subject = fields.grantType === 'refresh_token' ? refreshTokenSubject(fields.refreshToken) : undefined;
		if (subject) return [{ limiter: 'user', key: `${pathname}:user:${subject}` }];
		return [{ limiter: 'client', key: `${pathname}:client:${fields.clientId ?? 'unknown'}` }];
	}
	return [{ limiter: 'user', key: `${pathname}:ip:${clientIP}` }];
}
