/**
 * The page a suspended (or otherwise disabled) account sees instead of being
 * signed in (#662). Rendered in openauth's sign-in Layout with the request's
 * theme, like the sign-in and "Start sign-in again" pages, in the page's
 * language (en/ar from `?lang=`). Never a raw error.
 */
import { html } from 'hono/html';
import { Layout } from '@al-ummah-now/openauth/ui/base';
import type { Theme } from '@al-ummah-now/openauth/ui/theme';

type Locale = 'en' | 'ar';

const COPY: Record<Locale, { title: string; message: string; support: string; back: string }> = {
	en: {
		title: 'This account is suspended',
		message: "You can't sign in to this account right now.",
		support: 'If you think this is a mistake, contact us at',
		back: 'Back to Al Ummah Now',
	},
	ar: {
		title: 'هذا الحساب موقوف',
		message: 'لا يمكنك تسجيل الدخول إلى هذا الحساب حاليًا.',
		support: 'إذا كنت تعتقد أن هذا خطأ، تواصل معنا على',
		back: 'العودة إلى الأمة الآن',
	},
};

const SUPPORT_EMAIL = 'support@alummahnow.net';

export async function renderAccountSuspendedPage(locale: string, homeUrl: string, theme?: Theme): Promise<Response> {
	const lang: Locale = locale === 'ar' ? 'ar' : 'en';
	const t = COPY[lang];
	// hono/html escapes every interpolated value (homeUrl included)
	const body = html`<div data-component="form" data-page="account-suspended" role="alert">
		<h1 data-component="title">${t.title}</h1>
		<p data-component="description">${t.message}</p>
		<p data-component="description">${t.support} <a data-component="link" href="mailto:${SUPPORT_EMAIL}" dir="ltr">${SUPPORT_EMAIL}</a></p>
		<a data-component="button" href="${homeUrl}" data-action="home">${t.back}</a>
	</div>`;
	const page = Layout({ theme, locale: lang, children: body });
	return new Response(`<!DOCTYPE html>${await page.toString()}`, {
		status: 403,
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
			'Content-Language': lang,
			'Cache-Control': 'no-store',
		},
	});
}
