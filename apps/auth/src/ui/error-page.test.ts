import { describe, expect, it } from 'vitest';
import { contactHref, errorCodeLabel, errorPageLocale, renderErrorPage, renderNotFoundPage } from './error-page';

const req = (query = '', headers: Record<string, string> = {}) => new Request(`https://auth.alummahnow.net/authorize${query}`, { headers });

describe('error page language', () => {
	it('is English with no lang, even when the browser prefers Arabic', async () => {
		const res = await renderErrorPage(new Error('boom'), 'ERR-AAAA-0001', undefined, req('', { 'Accept-Language': 'ar-SA,ar;q=0.9' }));
		const html = await res.text();
		expect(html).toMatch(/<html[^>]*lang="en"/);
		expect(html).toContain('We could not load this page');
		expect(res.headers.get('Content-Language')).toBe('en');
	});

	it('is Arabic and right-to-left for ?lang=ar, with ٠–٩ in the code line', async () => {
		const res = await renderErrorPage(new Error('D1_ERROR'), 'ERR-AAAA-0002', undefined, req('?lang=ar'));
		const html = await res.text();
		expect(html).toMatch(/<html[^>]*lang="ar"/);
		expect(html).toMatch(/<html[^>]*dir="rtl"/);
		expect(html).toContain('تسجيل الدخول غير متاح مؤقتًا');
		expect(html).toContain('خطأ ٥٠٣');
		expect(res.status).toBe(503);
	});

	it('falls back to English for an unsupported or invalid lang', () => {
		for (const lang of ['fr', 'AR', 'ar-SA', 'constructor', '__proto__', '<x>']) {
			expect(errorPageLocale(req(`?lang=${encodeURIComponent(lang)}`))).toBe('en');
		}
		expect(errorPageLocale(undefined)).toBe('en');
	});
});

describe('the error-page family on Auth (wiki guides/error-pages.md)', () => {
	it('500: the reference to quote, Try again on the same page, noindex, never the raw error', async () => {
		const res = await renderErrorPage(new Error('secret SQL text'), 'ERR-AAAA-0003', 'https://auth.alummahnow.net/authorize?x=1', req());
		const html = await res.text();
		expect(res.status).toBe(500);
		expect(html).toContain('Error 500');
		expect(html).toContain('data-testid="error-reference">ERR-AAAA-0003<');
		expect(html).toContain('href="/authorize?x=1" data-action="retry"');
		expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
		expect(res.headers.get('X-Robots-Tag')).toBe('noindex');
		expect(html).not.toContain('secret SQL text');
		// The card's own parts never animate (the sign-in theme's lanterns follow prefers-reduced-motion)
		const card = /<style>([^<]*\[data-page=error\][^<]*)<\/style>/.exec(html)?.[1] ?? '';
		expect(card).toContain('.ep-badge');
		expect(card).not.toMatch(/@keyframes|animation|transition/);
	});

	it('Try again never leaves this origin', async () => {
		const html = await (await renderErrorPage(new Error('x'), 'ERR-AAAA-0004', 'https://evil.example/', req())).text();
		expect(html).not.toContain('evil.example');
		expect(html).toContain('data-action="home"');
	});

	it('404: the card, no reference, status 404', async () => {
		const res = await renderNotFoundPage(new Request('https://auth.alummahnow.net/nope?lang=ar'));
		const html = await res.text();
		expect(res.status).toBe(404);
		expect(html).toContain('الصفحة غير موجودة');
		expect(html).toContain('خطأ ٤٠٤');
		expect(html).not.toContain('error-reference');
	});

	it('code line and Contact us per environment', () => {
		expect(errorCodeLabel('ar', 404)).toBe('خطأ ٤٠٤');
		expect(contactHref(new URL('https://auth.qa.alummahnow.net/x'), 'en', 'ERR-1')).toBe('https://videos.qa.alummahnow.net/en/contact?ref=ERR-1');
		expect(contactHref(new URL('http://localhost:3301/x'), 'en')).toBe('mailto:support@alummahnow.net');
	});
});
