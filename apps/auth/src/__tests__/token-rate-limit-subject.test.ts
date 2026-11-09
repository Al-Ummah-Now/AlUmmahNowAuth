import { describe, it, expect } from 'vitest';
import {
	tokenRateLimitBuckets,
	readTokenRequestFields,
	refreshTokenSubject,
	isFirstPartyWorker,
} from '../utils/token-rate-limit-subject';

const WORKER_IP = '2a06:98c0:3600::103'; // observed on stage: profile → auth /token
const req = (worker?: string) =>
	new Request('https://auth.alummahnow.net/token', { method: 'POST', headers: worker ? { 'CF-Worker': worker } : {} });

describe('tokenRateLimitBuckets (AU-1: no shared bucket)', () => {
	it("counts our own Workers' refreshes per user", () => {
		const fields = { grantType: 'refresh_token', refreshToken: 'user:abc123:7b0f-uuid' };
		expect(tokenRateLimitBuckets(req('alummahnow.net'), '/token', WORKER_IP, fields)).toEqual([
			{ limiter: 'user', key: '/token:user:user:abc123' },
		]);
	});

	it("never keys an outside caller on the subject in an unchecked refresh token", () => {
		// Rotating fake subjects must not open new buckets, and naming a victim's
		// subject must not spend the victim's refreshes
		const outside = (token: string) =>
			tokenRateLimitBuckets(req(), '/token', '198.51.100.7', { grantType: 'refresh_token', refreshToken: token });
		expect(outside('user:victim:forged')).toEqual([{ limiter: 'user', key: '/token:ip:198.51.100.7' }]);
		const keys = new Set(Array.from({ length: 50 }, (_, i) => outside(`user:fake${i}:x`)[0].key));
		expect(keys.size).toBe(1);
		// A forged CF-Worker header from outside Cloudflare does not count as first-party
		expect(
			tokenRateLimitBuckets(req('alummahnow.net'), '/token', '198.51.100.7', { grantType: 'refresh_token', refreshToken: 'user:victim:x' })
		).toEqual([{ limiter: 'user', key: '/token:ip:198.51.100.7' }]);
	});

	it("counts our own Workers' other grants per client", () => {
		expect(
			tokenRateLimitBuckets(req('alummahnow.net'), '/token', WORKER_IP, { grantType: 'authorization_code', clientId: 'profile' })
		).toEqual([{ limiter: 'client', key: '/token:client:profile' }]);
	});

	it('counts everyone else per IP', () => {
		expect(tokenRateLimitBuckets(req(), '/token', '198.51.100.7', { grantType: 'authorization_code', clientId: 'x' })).toEqual([
			{ limiter: 'user', key: '/token:ip:198.51.100.7' },
		]);
	});

	it('different users never share a bucket', () => {
		const keys = new Set(
			Array.from({ length: 100 }, (_, i) =>
				tokenRateLimitBuckets(req('alummahnow.net'), '/token', WORKER_IP, {
					grantType: 'refresh_token',
					refreshToken: `user:u${i}:tok`,
				})[0].key
			)
		);
		expect(keys.size).toBe(100);
	});
});

describe('isFirstPartyWorker', () => {
	it('ignores a forged CF-Worker header from outside Cloudflare', () => {
		expect(isFirstPartyWorker(req('alummahnow.net'), '198.51.100.7')).toBe(false);
		expect(isFirstPartyWorker(req('alummahnow.net'), '2001:db8::1')).toBe(false);
	});

	it("keeps someone else's Worker out", () => {
		expect(isFirstPartyWorker(req('attacker.example'), WORKER_IP)).toBe(false);
	});

	it('matches the whole 2a06:98c0::/29 range and nothing next to it', () => {
		expect(isFirstPartyWorker(req('alummahnow.net'), '2a06:98c7:ffff::1')).toBe(true);
		expect(isFirstPartyWorker(req('alummahnow.net'), '2a06:98c8::1')).toBe(false);
		expect(isFirstPartyWorker(req('alummahnow.net'), '2a06:98b8::1')).toBe(false);
	});
});

describe('readTokenRequestFields', () => {
	it('reads a form body without consuming the request', async () => {
		const r = new Request('https://a/token', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'grant_type=refresh_token&refresh_token=user%3Aa%3Ab&client_id=c1',
		});
		expect(await readTokenRequestFields(r)).toEqual({ grantType: 'refresh_token', refreshToken: 'user:a:b', clientId: 'c1' });
		expect(await r.text()).toContain('grant_type'); // still readable by the issuer
	});

	it('takes the client from Basic auth', async () => {
		const r = new Request('https://a/token', {
			method: 'POST',
			headers: { Authorization: `Basic ${btoa('admin-client:secret')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'grant_type=client_credentials',
		});
		expect(await readTokenRequestFields(r)).toMatchObject({ grantType: 'client_credentials', clientId: 'admin-client' });
	});

	it('reads a JSON body (revocation)', async () => {
		const r = new Request('https://a/token/revoke', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ token: 'user:z:1' }),
		});
		expect((await readTokenRequestFields(r)).refreshToken).toBe('user:z:1');
	});
});

describe('refreshTokenSubject', () => {
	it('is everything before the last colon', () => {
		expect(refreshTokenSubject('user:abc:tok')).toBe('user:abc');
		expect(refreshTokenSubject('nocolon')).toBeUndefined();
		expect(refreshTokenSubject(undefined)).toBeUndefined();
	});
});
