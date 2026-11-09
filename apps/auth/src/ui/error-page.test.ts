import { describe, expect, it } from 'vitest';
import { errorPageLocale, renderErrorPage } from './error-page';

const req = (query = '', headers: Record<string, string> = {}) => new Request(`https://auth.alummahnow.net/authorize${query}`, { headers });

describe('error page language', () => {
	it('is English with no lang, even when the browser prefers Arabic', async () => {
		const res = renderErrorPage(new Error('boom'), 'req-1', undefined, req('', { 'Accept-Language': 'ar-SA,ar;q=0.9' }));
		const html = await res.text();
		expect(html).toContain('<html lang="en" dir="ltr">');
		expect(html).toContain('Something Went Wrong');
		expect(res.headers.get('Content-Language')).toBe('en');
	});

	it('is Arabic and right-to-left for ?lang=ar', async () => {
		const html = await renderErrorPage(new Error('D1_ERROR'), 'req-2', undefined, req('?lang=ar')).text();
		expect(html).toContain('<html lang="ar" dir="rtl">');
		expect(html).toContain('الخدمة غير متاحة مؤقتًا');
	});

	it('falls back to English for an unsupported or invalid lang', () => {
		for (const lang of ['fr', 'AR', 'ar-SA', 'constructor', '__proto__', '<x>']) {
			expect(errorPageLocale(req(`?lang=${encodeURIComponent(lang)}`))).toBe('en');
		}
		expect(errorPageLocale(undefined)).toBe('en');
	});
});
