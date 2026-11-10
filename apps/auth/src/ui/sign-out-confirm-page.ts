/**
 * "Sign out of Al Ummah Now?" (logout CSRF guard, SSO audit 2026-11-10).
 *
 * Single sign-out is a GET so every app can start it with a link and the
 * front-channel hops can redirect through it. A request that did not come from
 * one of our apps (another site's link, image, script or frame) is not trusted
 * to sign the browser out: it gets this page, and only its same-origin form
 * POST signs out. Rendered in openauth's sign-in Layout, in the page's
 * language (en/ar from `?lang=` only). Never a browser prompt.
 */
import { html } from 'hono/html';
import { Layout } from '@al-ummah-now/openauth/ui/base';

type Locale = 'en' | 'ar';

const COPY: Record<Locale, { title: string; message: string; signOut: string; stay: string }> = {
	en: {
		title: 'Sign out of Al Ummah Now?',
		message: 'You will be signed out of every Al Ummah Now app on this browser.',
		signOut: 'Sign out',
		stay: 'Stay signed in',
	},
	ar: {
		title: 'تسجيل الخروج من الأمة الآن؟',
		message: 'سيتم تسجيل خروجك من كل تطبيقات الأمة الآن على هذا المتصفح.',
		signOut: 'تسجيل الخروج',
		stay: 'البقاء مسجلاً',
	},
};

export async function renderSignOutConfirmPage(locale: string, returnTo: string): Promise<Response> {
	const lang: Locale = locale === 'ar' ? 'ar' : 'en';
	const t = COPY[lang];
	// hono/html escapes every interpolated value (returnTo included)
	const body = html`<form data-component="form" data-page="sign-out-confirm" method="post" action="/logout?lang=${lang}">
		<h1 data-component="title">${t.title}</h1>
		<p data-component="description">${t.message}</p>
		<input type="hidden" name="return" value="${returnTo}" />
		<button data-component="button" type="submit" data-action="sign-out">${t.signOut}</button>
		<a data-component="link" href="${returnTo}" data-action="stay">${t.stay}</a>
	</form>`;
	const page = Layout({ locale: lang, children: body });
	return new Response(`<!DOCTYPE html>${await page.toString()}`, {
		status: 200,
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
			'Content-Language': lang,
			'Cache-Control': 'no-store',
		},
	});
}
