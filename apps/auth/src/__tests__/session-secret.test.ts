import { describe, it, expect } from 'vitest';
import { sessionSecretUsable } from '../utils/session-secret';

/** The all-zero fallback key is public: only local development may run without SESSION_SECRET. */
describe('sessionSecretUsable', () => {
	it.each(['production', 'stage', 'qa', 'staging', '', undefined])('refuses a missing secret on %s', (ENVIRONMENT) => {
		expect(sessionSecretUsable({ ENVIRONMENT })).toBe(false);
		expect(sessionSecretUsable({ ENVIRONMENT, SESSION_SECRET: '' })).toBe(false);
	});

	it('allows the development fallback only on ENVIRONMENT exactly "development"', () => {
		expect(sessionSecretUsable({ ENVIRONMENT: 'development' })).toBe(true);
		expect(sessionSecretUsable({ ENVIRONMENT: 'Development' })).toBe(false);
		expect(sessionSecretUsable({ ENVIRONMENT: 'dev' })).toBe(false);
	});

	it('accepts any env with the secret set', () => {
		expect(sessionSecretUsable({ ENVIRONMENT: 'production', SESSION_SECRET: 'a'.repeat(64) })).toBe(true);
		expect(sessionSecretUsable({ ENVIRONMENT: 'stage', SESSION_SECRET: 'a'.repeat(64) })).toBe(true);
	});
});
