import { beforeEach, describe, expect, it } from 'vitest';
import { allowedSiteRedirect, isLiveSiteHost, resetSiteRedirectCache, siteCallbackHost } from '../utils/site-redirects';
import { logoutReturnUrlWithSites } from '../handlers/logout-handler';
import { withAddedRedirect } from '../utils/preview-redirects';
import { PKCE_REQUIRED_CLIENTS } from '../pkce-clients';
import qaConfig from '../../wrangler.qa.json';
import prodConfig from '../../wrangler.json';

const ENV = { SITES_CLIENT_ID: 'sites', SITES_REGISTRY_URL: 'https://videos.api.qa.alummahnow.net' };
const live = (host: string, over: Record<string, unknown> = {}) => Response.json({ host, redirectTo: null, preview: false, site: { status: 'live', primaryHost: host, ...over } });

describe('scholar site callbacks', () => {
	beforeEach(() => resetSiteRedirectCache());

	it('takes only the exact https /auth/callback of the sites client, never a platform host', () => {
		expect(siteCallbackHost(ENV, 'sites', 'https://mustafa.qa.alummahnow.org/auth/callback')).toBe('mustafa.qa.alummahnow.org');
		expect(siteCallbackHost(ENV, 'sites', 'https://example.com/auth/callback')).toBe('example.com');
		for (const bad of [
			'http://mustafa.qa.alummahnow.org/auth/callback',
			'https://mustafa.qa.alummahnow.org/auth/callback?x=1',
			'https://mustafa.qa.alummahnow.org/other',
			'https://www.alummahnow.net/auth/callback',
			'https://evil.example/https://mustafa.qa.alummahnow.org/auth/callback',
		]) expect(siteCallbackHost(ENV, 'sites', bad), bad).toBeNull();
		expect(siteCallbackHost(ENV, 'www', 'https://mustafa.qa.alummahnow.org/auth/callback')).toBeNull();
		expect(siteCallbackHost({}, 'sites', 'https://mustafa.qa.alummahnow.org/auth/callback')).toBeNull();
	});

	it('a host is allowed only while it is a live site\'s primary host (fails closed)', async () => {
		expect(await isLiveSiteHost(ENV, 'a.qa.alummahnow.org', async () => live('a.qa.alummahnow.org'))).toBe(true);
		resetSiteRedirectCache();
		expect(await isLiveSiteHost(ENV, 'a.qa.alummahnow.org', async () => live('a.qa.alummahnow.org', { status: 'setup' }))).toBe(false);
		resetSiteRedirectCache();
		expect(await isLiveSiteHost(ENV, 'a.qa.alummahnow.org', async () => live('a.qa.alummahnow.org', { primaryHost: 'b.qa.alummahnow.org' }))).toBe(false);
		resetSiteRedirectCache();
		expect(await isLiveSiteHost(ENV, 'old.qa.alummahnow.org', async () => Response.json({ redirectTo: 'https://new.qa.alummahnow.org' }))).toBe(false);
		resetSiteRedirectCache();
		expect(await isLiveSiteHost(ENV, 'a.qa.alummahnow.org', async () => new Response('', { status: 404 }))).toBe(false);
		resetSiteRedirectCache();
		expect(await isLiveSiteHost(ENV, 'a.qa.alummahnow.org', async () => { throw new Error('down'); })).toBe(false);
	});

	it('adds the one redirect for /authorize only, and the registry answer is cached', async () => {
		let calls = 0;
		const fetcher = async () => (calls++, live('m.qa.alummahnow.org'));
		const authorize = (uri: string) => new Request(`https://auth.qa.alummahnow.net/authorize?client_id=sites&redirect_uri=${encodeURIComponent(uri)}`);
		expect(await allowedSiteRedirect(ENV, authorize('https://m.qa.alummahnow.org/auth/callback'), fetcher)).toEqual({ clientId: 'sites', redirectUri: 'https://m.qa.alummahnow.org/auth/callback' });
		await allowedSiteRedirect(ENV, authorize('https://m.qa.alummahnow.org/auth/callback'), fetcher);
		expect(calls).toBe(1);
		expect(await allowedSiteRedirect(ENV, new Request('https://auth.qa.alummahnow.net/token?client_id=sites&redirect_uri=https%3A%2F%2Fm.qa.alummahnow.org%2Fauth%2Fcallback'), fetcher)).toBeNull();
	});

	it('the registry sees exactly that one redirect added for that one client', async () => {
		const row = { client_id: 'sites', redirect_uris: '[]' };
		const db = { prepare: () => ({ bind: () => ({ first: async () => row }) }) } as unknown as D1Database;
		const wrapped = withAddedRedirect(db, 'sites', 'https://m.qa.alummahnow.org/auth/callback');
		const got = (await wrapped.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').bind('sites').first()) as { redirect_uris: string };
		expect(JSON.parse(got.redirect_uris)).toEqual(['https://m.qa.alummahnow.org/auth/callback']);
		const other = (await wrapped.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').bind('www').first()) as { redirect_uris: string };
		expect(other.redirect_uris).toBe('[]');
	});

	it('logout may end on a live site page, never on an unknown host', async () => {
		const env = { ...ENV, AUTH_STORAGE: {} as KVNamespace, SIGN_IN_FALLBACK_URL: 'https://videos.qa.alummahnow.net/' };
		expect(await logoutReturnUrlWithSites(env, 'https://m.qa.alummahnow.org/ar/', 'https://auth.qa.alummahnow.net', async () => live('m.qa.alummahnow.org'))).toBe('https://m.qa.alummahnow.org/ar/');
		resetSiteRedirectCache();
		expect(await logoutReturnUrlWithSites(env, 'https://evil.example/', 'https://auth.qa.alummahnow.net', async () => new Response('', { status: 404 }))).toBe('https://videos.qa.alummahnow.net/');
	});

	it('is configured per env, and the sites clients must send PKCE', () => {
		expect(qaConfig.vars.SITES_CLIENT_ID).toBe('0abd9eac-e47e-4a1a-90bd-18cffec0303c');
		expect(qaConfig.vars.SITES_REGISTRY_URL).toBe('https://videos.api.qa.alummahnow.net');
		const envs = (prodConfig as unknown as { env: Record<string, { vars: Record<string, string> }> }).env;
		expect(envs.production?.vars.SITES_REGISTRY_URL).toBe('https://videos.api.alummahnow.net');
		expect(envs.stage?.vars.SITES_REGISTRY_URL).toBe('https://videos.api.stage.alummahnow.net');
		expect(PKCE_REQUIRED_CLIENTS).toEqual(expect.arrayContaining(['0abd9eac-e47e-4a1a-90bd-18cffec0303c', '81f2bb95-15c6-4896-b414-be2c24155a74']));
	});
});
