import { describe, expect, it } from 'vitest';
import { hashClientSecret, stageRedirectUrisFor, toStageRedirectUris } from '../seed.ts';
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

	it('keeps native app redirects (custom schemes, loopback) and rewrites their universal links', () => {
		expect(
			toStageRedirectUris(['alummahnow://auth/callback', 'https://videos.alummahnow.net/app/auth/callback', 'http://127.0.0.1/auth/callback', 'alummahnow-studio://auth/callback'])
		).toEqual(['alummahnow://auth/callback', 'https://videos.stage.alummahnow.net/app/auth/callback', 'http://127.0.0.1/auth/callback', 'alummahnow-studio://auth/callback']);
		expect(toStageRedirectUris(['http://localhost:3000/cb', 'evil://videos.alummahnow.net/cb'])).toEqual([]);
	});

	it('is idempotent on rows already rewritten, including native ones', () => {
		expect(toStageRedirectUris(['alummahnow://auth/callback', 'https://videos.stage.alummahnow.net/app/auth/callback'])).toEqual([]);
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

describe('stageRedirectUrisFor', () => {
	it('rewrites www and cms hosts', () => {
		expect(
			toStageRedirectUris(['https://www.alummahnow.net/auth/callback', 'https://cms.alummahnow.net/sso/callback', 'http://localhost:4321/auth/callback'])
		).toEqual(['https://www.stage.alummahnow.net/auth/callback', 'https://cms.stage.alummahnow.net/sso/callback']);
	});

	it('prefers the live prod values when the client exists in prod', () => {
		expect(stageRedirectUrisFor(['https://cms.alummahnow.net/sso/callback?x=1'], ['https://cms.alummahnow.net/sso/callback'])).toEqual([
			'https://cms.stage.alummahnow.net/sso/callback?x=1',
		]);
	});

	it('falls back to the seeded values for a client not in prod yet', () => {
		expect(stageRedirectUrisFor(undefined, ['https://cms.alummahnow.net/sso/callback'])).toEqual(['https://cms.stage.alummahnow.net/sso/callback']);
	});

	it('is a no-op for rows already rewritten to stage', () => {
		expect(stageRedirectUrisFor(undefined, ['https://cms.stage.alummahnow.net/sso/callback'])).toEqual([]);
	});
});
