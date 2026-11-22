import { describe, expect, it } from 'vitest';
import { ERROR_PAGE_CSS } from './error-page-css.vendored';
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
		expect(res.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
		expect(html).not.toContain('secret SQL text');
		// The card's own parts never animate (the sign-in theme's lanterns follow prefers-reduced-motion)
		const card = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).find((css) => css.includes('.ep-badge')) ?? '';
		expect(card).toContain('.ep-badge');
		expect(card).not.toMatch(/@keyframes|animation:|transition:/);
	});

	it('Try again never leaves this origin', async () => {
		const html = await (await renderErrorPage(new Error('x'), 'ERR-AAAA-0004', 'https://evil.example/', req())).text();
		expect(html).not.toContain('evil.example');
		expect(html).toContain('data-action="home"');
	});

	it('Try again is always a path on this origin, never protocol-relative', async () => {
		for (const path of ['//evil.example/x', '/%2F%2Fevil.example', '/\\evil.example/x']) {
			const html = await (await renderErrorPage(new Error('x'), 'ERR-AAAA-0007', undefined, new Request(`https://auth.alummahnow.net${path}`))).text();
			const href = /href="([^"]*)" data-action="retry"/.exec(html)?.[1] ?? '';
			expect(href.startsWith('/')).toBe(true);
			expect(href.startsWith('//')).toBe(false);
			expect(href.startsWith('/\\')).toBe(false);
		}
		const own = await (await renderErrorPage(new Error('x'), 'ERR-AAAA-0008', 'https://auth.alummahnow.net//evil.example/', req())).text();
		expect(/href="([^"]*)" data-action="retry"/.exec(own)?.[1]).toBe('/evil.example/');
	});

	it('the lantern street is the sign-in pages\' tile street: the variant on <html>, a cookie pins it, the header is the family header', async () => {
		for (const res of [await renderErrorPage(new Error('x'), 'ERR-AAAA-0009', undefined, req()), await renderNotFoundPage(new Request('https://auth.alummahnow.net/nope'))]) {
			const html = await res.text();
			expect(html).toMatch(/<html[^>]*\sdata-fanous-street-variant="[1-4]"/);
			expect(html).toContain('/fanous-street/');
			// no region of its own: the tile covers the whole page and the card covers the tile
			expect(html).not.toContain('data-fanous-street-region');
			expect(html).toContain('[data-component=root]:has(.ep){min-height:100dvh}');
			// Fawanees' header: the gradient and the gold underline, as on the videos site
			expect(html).toContain('html[data-theme="fawanees"] .aun-header{--aun-header-bg:linear-gradient(90deg');
		}
		const pinned = await renderNotFoundPage(new Request('https://auth.alummahnow.net/nope', { headers: { Cookie: 'aun_street_variant=3' } }));
		expect(await pinned.text()).toMatch(/<html[^>]*\sdata-fanous-street-variant="3"/);
	});

	it('404: the card, no reference, status 404', async () => {
		const res = await renderNotFoundPage(new Request('https://auth.alummahnow.net/nope?lang=ar'));
		const html = await res.text();
		expect(res.status).toBe(404);
		expect(html).toContain('الصفحة غير موجودة');
		expect(html).toContain('خطأ ٤٠٤');
		expect(html).not.toContain('error-reference');
		// one inline-block span a sentence: no line ends on «ربما», the next sentence's first word
		expect(html).toContain('<p class="ep-body"><span class="ep-s">لم نعثر على هذه الصفحة.</span> <span class="ep-s">ربما الرابط غير صحيح أو نُقلت الصفحة.</span></p>');
		expect(ERROR_PAGE_CSS).toContain('.ep-s{display:inline-block}');
	});

	it('is the family card: the vendored sheet, family buttons, one h1, no sign-in branding', async () => {
		const html = await (await renderErrorPage(new Error('x'), 'ERR-AAAA-0005', undefined, req())).text();
		expect(html).toContain(ERROR_PAGE_CSS);
		expect(html.match(/<h1\b/g)).toHaveLength(1);
		expect(html).toContain('<h1 class="ep-title" id="ep-title">We could not load this page</h1>');
		expect(html).not.toContain('<div data-component="branding"');
		expect(html).not.toContain('<h1 data-component="site-title"');
		// 500: Home page (outlined) then Try again (filled, last); no Go back
		expect(html).toMatch(/class="ep-btn ep-btn-secondary" href="[^"]*" data-action="home">.*<span>Home page<\/span><\/a>\s*<a class="ep-btn ep-btn-primary" href="\/authorize" data-action="retry">/s);
		expect(html).not.toContain('data-ep-back hidden');
		expect(html).not.toMatch(/<a[^>]*data-component="button"/);
		expect(html).toMatch(/<p class="ep-help">Still stuck\? <a href="[^"]+">Contact us<\/a><\/p>/);
		expect(html).toContain('<title>We could not load this page | Al Ummah Now</title>');
		expect(html.match(/name="robots"/g)).toHaveLength(1);
	});

	it('404: Go back (outlined, shown when there is history) then Home page (filled); curly apostrophe', async () => {
		const html = await (await renderNotFoundPage(new Request('https://auth.alummahnow.net/nope'))).text();
		expect(html).toMatch(/<button type="button" class="ep-btn ep-btn-secondary" data-ep-back hidden>.*<span>Go back<\/span><\/button>\s*<a class="ep-btn ep-btn-primary" href="[^"]*" data-action="home">/s);
		expect(html).toContain('We couldn’t find this page.');
		expect(html).not.toContain("couldn't");
		expect(html).not.toContain('role="alert"');
	});

	it('Arabic: the card is rtl with the Arabic tab title and font', async () => {
		const html = await (await renderErrorPage(new Error('x'), 'ERR-AAAA-0006', undefined, req('?lang=ar'))).text();
		expect(html).toContain('class="ep" lang="ar" dir="rtl"');
		expect(html).toContain('<title>تعذّر تحميل هذه الصفحة | الأمة الآن</title>');
		expect(html).toContain('.ep[lang=ar]{font-family:var(--fanous-font-arabic');
		expect(html).toContain('<code id="ep-ref" class="ep-ref-code" dir="ltr" data-testid="error-reference">ERR-AAAA-0006</code>');
	});

	it('code line and Contact us per environment', () => {
		expect(errorCodeLabel('ar', 404)).toBe('خطأ ٤٠٤');
		expect(contactHref(new URL('https://auth.qa.alummahnow.net/x'), 'en', 'ERR-1')).toBe('https://videos.qa.alummahnow.net/en/contact?ref=ERR-1');
		expect(contactHref(new URL('http://localhost:3301/x'), 'en')).toBe('mailto:support@alummahnow.net');
	});
});
