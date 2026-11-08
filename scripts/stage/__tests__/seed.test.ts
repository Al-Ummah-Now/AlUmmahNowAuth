import { describe, expect, it } from 'vitest';
import { hashClientSecret, toStageRedirectUris } from '../seed.ts';
// openauth's own verifier: the stage admin secret must be accepted by the issuer
import { verifyClientSecret } from '../../../apps/auth/node_modules/@al-ummah-now/openauth/dist/esm/client/secret-generator.js';

describe('toStageRedirectUris', () => {
	it('maps prod hosts to stage hosts, keeping paths, and drops localhost', () => {
		expect(
			toStageRedirectUris([
				'http://localhost:3001/api/callback',
				'https://videos.alummahnow.net/api/callback',
				'https://videos.alummahnow.net/api/callback/multi-account',
				'https://admin.auth.alummahnow.net/auth/callback',
				'https://profile.auth.alummahnow.net/callback',
			])
		).toEqual([
			'https://videos.stage.alummahnow.net/api/callback',
			'https://videos.stage.alummahnow.net/api/callback/multi-account',
			'https://admin.auth.stage.alummahnow.net/auth/callback',
			'https://profile.auth.stage.alummahnow.net/callback',
		]);
	});

	it('drops unknown hosts instead of guessing', () => {
		expect(toStageRedirectUris(['https://admin.example.com/callback', 'com.example.app://callback'])).toEqual([]);
	});

	it('is idempotent on already-stage URIs', () => {
		expect(toStageRedirectUris(['https://videos.stage.alummahnow.net/api/callback'])).toEqual([]);
	});
});

describe('hashClientSecret', () => {
	it('produces hashes openauth verifies', async () => {
		const hash = hashClientSecret('a-stage-secret');
		expect(hash).toMatch(/^\$pbkdf2-sha256\$100000\$/);
		expect(await verifyClientSecret('a-stage-secret', hash)).toBe(true);
		expect(await verifyClientSecret('wrong', hash)).toBe(false);
	});
});
