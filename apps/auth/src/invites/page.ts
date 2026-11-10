/**
 * The invite link's page (GET /invite/:token) in the sign-in look, English
 * unless ?lang=ar. A GET never spends the token (mail scanners open links);
 * "Continue" (POST) spends it and goes to the app's sign-in. An expired, used
 * or unknown link explains that signing in with the invited email still works.
 */
import { html } from 'hono/html';
import { Layout } from '@al-ummah-now/openauth/ui/base';
import type { Theme } from '@al-ummah-now/openauth/ui/theme';

type Locale = 'en' | 'ar';

const COPY: Record<Locale, {
	title: string;
	ready: (email: string) => string;
	how: string;
	continue: string;
	staleTitle: string;
	stale: string;
	signIn: string;
}> = {
	en: {
		title: "You're invited to Al Ummah Now",
		ready: (email) => `Your account ${email} is ready, with everything the admin set up for you.`,
		how: 'Continue, then sign in with this email. No password yet? Choose "Create account" and confirm the code we email you.',
		continue: 'Continue',
		staleTitle: 'This invite link no longer works',
		stale: 'It has expired or was already used. Your account is still waiting: sign in with the email address the invite was sent to.',
		signIn: 'Sign in',
	},
	ar: {
		title: 'دعوة للانضمام إلى الأمة الآن',
		ready: (email) => `حسابك ${email} جاهز بكل ما أعدّه المشرف لك.`,
		how: 'تابع ثم سجّل الدخول بهذا البريد. ليست لديك كلمة مرور بعد؟ اختر «إنشاء حساب» وأكّد الرمز الذي نرسله إليك.',
		continue: 'متابعة',
		staleTitle: 'رابط الدعوة هذا لم يعد صالحًا',
		stale: 'انتهت صلاحيته أو استُخدم من قبل. حسابك ما زال بانتظارك: سجّل الدخول بالبريد الإلكتروني الذي أُرسلت إليه الدعوة.',
		signIn: 'تسجيل الدخول',
	},
};

export const pageLocale = (url: URL): Locale => (url.searchParams.get('lang') === 'ar' ? 'ar' : 'en');

async function respond(body: ReturnType<typeof html>, lang: Locale, theme: Theme | undefined, status: number): Promise<Response> {
	const page = Layout({ theme, locale: lang, children: body });
	return new Response(`<!DOCTYPE html>${await page.toString()}`, {
		status,
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
			'Content-Language': lang,
			'Cache-Control': 'no-store',
			'Referrer-Policy': 'no-referrer',
			'X-Robots-Tag': 'noindex',
		},
	});
}

/** A usable link: who it is for, and a POST form that spends the token. */
export function renderInvitePage(lang: Locale, email: string, action: string, theme?: Theme): Promise<Response> {
	const t = COPY[lang];
	// hono/html escapes every interpolated value
	const body = html`<form data-component="form" data-page="invite" method="post" action="${action}">
		<h1 data-component="title">${t.title}</h1>
		<p data-component="description">${t.ready(email)}</p>
		<p data-component="description">${t.how}</p>
		<button data-component="button" type="submit" data-action="accept-invite">${t.continue}</button>
	</form>`;
	return respond(body, lang, theme, 200);
}

/** Expired, used, revoked or unknown: the same page for all, so a link reveals nothing. */
export function renderStaleInvitePage(lang: Locale, signInUrl: string, theme?: Theme): Promise<Response> {
	const t = COPY[lang];
	const body = html`<div data-component="form" data-page="invite-stale" role="status">
		<h1 data-component="title">${t.staleTitle}</h1>
		<p data-component="description">${t.stale}</p>
		<a data-component="button" href="${signInUrl}" data-action="sign-in">${t.signIn}</a>
	</div>`;
	return respond(body, lang, theme, 410);
}
