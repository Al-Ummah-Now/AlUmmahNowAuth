/**
 * Picks the rate-limit bucket for a token-endpoint request.
 *
 * Profile, admin and web exchange codes and refresh tokens server-side, from
 * Workers. Cloudflare gives those subrequests a shared Workers egress address as
 * CF-Connecting-IP, so a per-IP bucket puts every user of those apps in one
 * bucket: about 10 sign-ins a minute across all users, after which sign-in fails
 * (found on stage, 2026-11-08). Requests from our own Workers get a per-zone bucket
 * with a higher limit instead. Everyone else keeps the per-IP bucket.
 */

/** Zones whose Workers are first-party clients (CF-Worker carries the zone name). */
export const FIRST_PARTY_WORKER_ZONES: readonly string[] = ['alummahnow.net'];

/** First-party bucket limit = endpoint limit × this (prod default: 10 → 500 per window). */
export const FIRST_PARTY_LIMIT_FACTOR = 50;

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

export interface TokenRateLimitSubject {
	key: string;
	limit: number;
	firstParty: boolean;
}

export function tokenRateLimitSubject(request: Request, pathname: string, clientIP: string, baseLimit: number): TokenRateLimitSubject {
	const zone = request.headers.get('CF-Worker')?.toLowerCase();
	if (zone && FIRST_PARTY_WORKER_ZONES.includes(zone) && isCloudflareWorkersEgress(clientIP)) {
		return { key: `token:${pathname}:worker:${zone}`, limit: baseLimit * FIRST_PARTY_LIMIT_FACTOR, firstParty: true };
	}
	return { key: `token:${pathname}:${clientIP}`, limit: baseLimit, firstParty: false };
}
