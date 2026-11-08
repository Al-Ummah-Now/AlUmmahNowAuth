import { describe, it, expect } from 'vitest';
import { tokenRateLimitSubject, FIRST_PARTY_LIMIT_FACTOR } from '../utils/token-rate-limit-subject';

const WORKER_IP = '2a06:98c0:3600::103'; // observed on stage: profile → auth /token
const req = (worker?: string) => new Request('https://auth.alummahnow.net/token', { method: 'POST', headers: worker ? { 'CF-Worker': worker } : {} });

describe('tokenRateLimitSubject', () => {
	it('gives our own Workers a shared per-zone bucket with a higher limit', () => {
		expect(tokenRateLimitSubject(req('alummahnow.net'), '/token', WORKER_IP, 10)).toEqual({
			key: 'token:/token:worker:alummahnow.net',
			limit: 10 * FIRST_PARTY_LIMIT_FACTOR,
			firstParty: true,
		});
	});

	it('keeps the per-IP bucket for browsers and other clients', () => {
		expect(tokenRateLimitSubject(req(), '/token', '198.51.100.7', 10)).toEqual({ key: 'token:/token:198.51.100.7', limit: 10, firstParty: false });
	});

	it('ignores a forged CF-Worker header from outside Cloudflare', () => {
		expect(tokenRateLimitSubject(req('alummahnow.net'), '/token', '198.51.100.7', 10).firstParty).toBe(false);
		expect(tokenRateLimitSubject(req('alummahnow.net'), '/token', '2001:db8::1', 10).firstParty).toBe(false);
	});

	it("keeps someone else's Worker on the per-IP bucket", () => {
		expect(tokenRateLimitSubject(req('attacker.example'), '/token', WORKER_IP, 10).firstParty).toBe(false);
	});

	it('matches the whole 2a06:98c0::/29 range and nothing next to it', () => {
		expect(tokenRateLimitSubject(req('alummahnow.net'), '/token', '2a06:98c7:ffff::1', 10).firstParty).toBe(true);
		expect(tokenRateLimitSubject(req('alummahnow.net'), '/token', '2a06:98c8::1', 10).firstParty).toBe(false);
		expect(tokenRateLimitSubject(req('alummahnow.net'), '/token', '2a06:98b8::1', 10).firstParty).toBe(false);
	});
});
