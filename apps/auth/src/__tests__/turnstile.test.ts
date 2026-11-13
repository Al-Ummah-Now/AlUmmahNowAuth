import { describe, it, expect, vi } from 'vitest';
import {
	BYPASS_HEADER,
	BYPASS_MAX_AGE_SECONDS,
	checkHuman,
	hasValidBypass,
	injectTurnstile,
	isBadUserAgent,
	signBypass,
	SITEVERIFY_URL,
	STUB_SCRIPT,
	TEST_SECRETS,
	TEST_SITE_KEYS,
	turnstileMode,
	verifyTurnstileToken,
	widgetScriptUrl,
} from '../security/turnstile';

const REAL_KEY = '0x4AAAAAAAreal-site-key';
const REAL_SECRET = '0x4AAAAAAAreal-secret';

const siteverify = (answer: unknown, status = 200) =>
	vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(answer), { status })) as unknown as typeof fetch;

describe('turnstileMode', () => {
	it('defaults to off and ignores unknown values', () => {
		expect(turnstileMode({})).toBe('off');
		expect(turnstileMode({ TURNSTILE_MODE: 'yes', TURNSTILE_SITE_KEY: REAL_KEY })).toBe('off');
		expect(turnstileMode({ TURNSTILE_MODE: 'enforce', TURNSTILE_SITE_KEY: REAL_KEY })).toBe('enforce');
	});
	it('is off without a site key, and off in production with a test key', () => {
		expect(turnstileMode({ TURNSTILE_MODE: 'enforce' })).toBe('off');
		expect(turnstileMode({ ENVIRONMENT: 'production', TURNSTILE_MODE: 'enforce', TURNSTILE_SITE_KEY: TEST_SITE_KEYS.pass })).toBe('off');
		expect(turnstileMode({ ENVIRONMENT: 'stage', TURNSTILE_MODE: 'enforce', TURNSTILE_SITE_KEY: TEST_SITE_KEYS.pass })).toBe('enforce');
	});
	it('loads the stub only for test keys outside production', () => {
		expect(widgetScriptUrl({ ENVIRONMENT: 'qa', TURNSTILE_SITE_KEY: TEST_SITE_KEYS.pass })).toBe('/turnstile/stub.js');
		expect(widgetScriptUrl({ ENVIRONMENT: 'qa', TURNSTILE_SITE_KEY: REAL_KEY })).toContain('challenges.cloudflare.com');
		expect(widgetScriptUrl({ ENVIRONMENT: 'production', TURNSTILE_SITE_KEY: REAL_KEY })).toContain('challenges.cloudflare.com');
	});
});

describe('verifyTurnstileToken', () => {
	it('answers the test secrets locally (no fetch)', async () => {
		const fetcher = siteverify({ success: true });
		expect((await verifyTurnstileToken({ TURNSTILE_SECRET: TEST_SECRETS.pass }, 'x', { fetcher })).outcome).toBe('pass');
		expect((await verifyTurnstileToken({ TURNSTILE_SECRET: TEST_SECRETS.fail }, 'x', { fetcher })).outcome).toBe('fail');
		expect((await verifyTurnstileToken({ TURNSTILE_SECRET: TEST_SECRETS.spent }, 'x', { fetcher })).codes).toEqual(['timeout-or-duplicate']);
		expect(fetcher).not.toHaveBeenCalled();
	});
	it('refuses a test secret in production', async () => {
		const result = await verifyTurnstileToken({ ENVIRONMENT: 'production', TURNSTILE_SECRET: TEST_SECRETS.pass }, 'x');
		expect(result).toEqual({ outcome: 'error', codes: ['test-secret-in-production'] });
	});
	it('posts secret, token and IP to siteverify', async () => {
		const fetcher = siteverify({ success: true });
		const result = await verifyTurnstileToken({ TURNSTILE_SECRET: { get: async () => REAL_SECRET } }, 'tok', { fetcher, ip: '203.0.113.5' });
		expect(result.outcome).toBe('pass');
		const [url, init] = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(url).toBe(SITEVERIFY_URL);
		const body = init.body as FormData;
		expect(body.get('secret')).toBe(REAL_SECRET);
		expect(body.get('response')).toBe('tok');
		expect(body.get('remoteip')).toBe('203.0.113.5');
	});
	it('maps failures, our own config faults and outages', async () => {
		const env = { TURNSTILE_SECRET: REAL_SECRET };
		expect((await verifyTurnstileToken(env, 't', { fetcher: siteverify({ success: false, 'error-codes': ['invalid-input-response'] }) })).outcome).toBe('fail');
		expect((await verifyTurnstileToken(env, 't', { fetcher: siteverify({ success: false, 'error-codes': ['invalid-input-secret'] }) })).outcome).toBe('error');
		expect((await verifyTurnstileToken(env, 't', { fetcher: siteverify({}, 503) })).outcome).toBe('error');
		const down = vi.fn(async () => {
			throw new Error('network');
		}) as unknown as typeof fetch;
		expect((await verifyTurnstileToken(env, 't', { fetcher: down })).outcome).toBe('error');
		expect((await verifyTurnstileToken(env, '', { fetcher: down })).outcome).toBe('missing');
		expect((await verifyTurnstileToken({}, 't')).outcome).toBe('error');
	});
});

describe('checkHuman', () => {
	const req = new Request('https://auth.example/password/register', { method: 'POST' });
	it('enforce refuses failures but lets a siteverify outage through', async () => {
		const env = { TURNSTILE_MODE: 'enforce', TURNSTILE_SITE_KEY: REAL_KEY, TURNSTILE_SECRET: REAL_SECRET };
		expect((await checkHuman(env, req, 't', 'x', { fetcher: siteverify({ success: false }) })).allowed).toBe(false);
		expect((await checkHuman(env, req, null, 'x')).allowed).toBe(false);
		expect((await checkHuman(env, req, 't', 'x', { fetcher: siteverify({}, 500) })).allowed).toBe(true);
	});
	it('monitor never refuses; off never checks', async () => {
		const fetcher = siteverify({ success: false });
		expect((await checkHuman({ TURNSTILE_MODE: 'monitor', TURNSTILE_SITE_KEY: REAL_KEY, TURNSTILE_SECRET: REAL_SECRET }, req, 't', 'x', { fetcher })).allowed).toBe(true);
		const off = await checkHuman({}, req, null, 'x', { fetcher });
		expect(off).toEqual({ allowed: true, outcome: 'off' });
	});
});

describe('signed bypass', () => {
	const env = { ENVIRONMENT: 'qa', BOT_BYPASS_SECRET: 's3cret' };
	const withHeader = (value: string) => new Request('https://x/', { headers: { [BYPASS_HEADER]: value } });
	it('accepts a fresh signature, refuses stale, forged and malformed ones', async () => {
		const now = 1_800_000_000;
		expect(await hasValidBypass(env, withHeader(await signBypass('s3cret', now)), now)).toBe(true);
		expect(await hasValidBypass(env, withHeader(await signBypass('s3cret', now - BYPASS_MAX_AGE_SECONDS - 1)), now)).toBe(false);
		expect(await hasValidBypass(env, withHeader(await signBypass('other', now)), now)).toBe(false);
		expect(await hasValidBypass(env, withHeader('v1.1800000000.zz'), now)).toBe(false);
		expect(await hasValidBypass(env, new Request('https://x/'), now)).toBe(false);
	});
	it('is never honoured in production or without a secret', async () => {
		const now = 1_800_000_000;
		const value = await signBypass('s3cret', now);
		expect(await hasValidBypass({ ...env, ENVIRONMENT: 'production' }, withHeader(value), now)).toBe(false);
		expect(await hasValidBypass({ ENVIRONMENT: 'qa' }, withHeader(value), now)).toBe(false);
	});
});

describe('isBadUserAgent', () => {
	it('flags scripting clients and an empty agent', () => {
		for (const ua of ['', 'curl/8.4.0', 'python-requests/2.31', 'Go-http-client/2.0', 'Wget/1.21', 'Scrapy/2.11']) expect(isBadUserAgent(ua)).toBe(true);
		expect(isBadUserAgent(null)).toBe(true);
	});
	it('lets browsers, our native apps and crawlers through', () => {
		for (const ua of [
			'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15',
			'okhttp/4.12.0',
			'AlUmmahNow/1.0 CFNetwork/1490 Darwin/23.0.0',
			'Ktor client',
			'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
		])
			expect(isBadUserAgent(ua)).toBe(false);
	});
});

describe('injectTurnstile', () => {
	const page = '<html><body><form method="post"><input name="email"/></form><form method="post"></form></body></html>';
	it('adds one widget to the first form and the scripts before </body>, escaping attributes', () => {
		const html = injectTurnstile(page, { siteKey: 'k"<', scriptUrl: '/turnstile/stub.js', action: 'sign_up', lang: 'en' });
		expect(html.match(/data-aun-turnstile /g)?.length).toBe(1);
		expect(html.indexOf('data-aun-turnstile ')).toBeLessThan(html.indexOf('</form>'));
		expect(html).toContain('data-sitekey="k&quot;&lt;"');
		expect(html).toContain('<script src="/turnstile/stub.js?onload=aunTurnstileReady&amp;render=explicit" async defer></script></body>');
		expect(html).toContain('role="status"');
		expect(injectTurnstile(html, { siteKey: 'k', scriptUrl: 's', action: 'a', lang: 'en' })).toBe(html);
	});
	it('leaves pages without a form alone', () => {
		expect(injectTurnstile('<html><body>hi</body></html>', { siteKey: 'k', scriptUrl: 's', action: 'a', lang: 'ar' })).toBe('<html><body>hi</body></html>');
	});
});

describe('page scripts', () => {
	it('the stub and the inline widget script are valid JavaScript', () => {
		expect(() => new Function(STUB_SCRIPT)).not.toThrow();
		const html = injectTurnstile('<form></form></body>', { siteKey: 'k', scriptUrl: 's', action: 'a', lang: 'ar' });
		const inline = html.slice(html.indexOf('<script>') + 8, html.indexOf('</script>'));
		expect(() => new Function(inline)).not.toThrow();
	});
});
