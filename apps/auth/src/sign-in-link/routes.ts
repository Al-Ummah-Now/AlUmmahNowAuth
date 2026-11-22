/**
 * Accounts with no sign-in method yet (docs/USER_INVITES.md "No sign-in method yet").
 *
 * An invited account whose passkey was skipped or failed has no password and
 * no passkey. On the normal sign-in page, once the email is typed, it is not
 * asked for a password; it gets two options instead:
 *
 * - "Email me a sign-in link": the invite's single-use link (invites/routes.ts
 *   emailLinkIfWaiting), in its own short email. It signs in and offers the
 *   passkey card again.
 * - "Add a password": /password/register with `setup=1`. Its emailed code proves
 *   the inbox, then the password is set (and an invited account is claimed).
 *
 * What it reveals: only whether the email has a password, which the sign-in page
 * already says (registering with it answers "email taken"). An unknown email and
 * an account with no method get the very same options and pages, and "Email me a
 * sign-in link" answers the same page whether or not anything was sent; the
 * lookup and the send run after the answer.
 *
 * Routes:
 *   POST /sign-in/method  { email } → { password: boolean }   the sign-in page's check (same origin)
 *   POST /sign-in/link    form email, csrf, lang, back        "Email me a sign-in link"
 * Limits: the check, PASSWORD_IP_LIMITER per IP and PASSWORD_EMAIL_LIMITER per
 * email hash; the link, SEND_CODE_LIMITER per IP and per email hash (the
 * invite resend's limits).
 */
import { html, raw } from 'hono/html';
import { Layout } from '@al-ummah-now/openauth/ui/base';
import type { Theme } from '@al-ummah-now/openauth/ui/theme';
import { Storage } from '@al-ummah-now/openauth/storage/storage';
import type { StorageAdapter } from '@al-ummah-now/openauth/storage/storage';
import { getClientIP, RATE_LIMIT_PERIOD_SECONDS, withinRateLimit } from '../rate-limit';
import { hashToken } from '../utils/crypto';
import { logger } from '../logger';
import { authStorage } from '../storage/auth-storage';
import { emailLinkIfWaiting, plausibleEmail } from '../invites/routes';
import { normalizeInviteEmail } from '../invites/service';

export type Lang = 'en' | 'ar';
export const SIGN_IN_METHOD_PATH = '/sign-in/method';
export const SIGN_IN_LINK_PATH = '/sign-in/link';
export const CSRF_COOKIE = 'signin_csrf';
/** sessionStorage key: the email typed on the sign-in page, prefilled by "Add a password" */
export const SETUP_EMAIL_KEY = 'aun.setupEmail';

const COPY = {
	en: {
		noPassword: 'This email has no password yet. Choose how to sign in:',
		link: 'Email me a sign-in link',
		addPassword: 'Add a password',
		hint: 'The link works once and signs you in. To add a password, we first email you a code to confirm it’s your inbox.',
		setupTitle: 'Add a password',
		setupText: 'We’ll email you a code to confirm it’s your inbox. Then your password is saved and you’re signed in.',
		sentTitle: 'Check your inbox',
		sent: (email: string) => [`If `, email, ` can sign in with a link, we’ve sent one. It works once: open it to sign in. If nothing arrives in a few minutes, check your spam folder, or go back and add a password.`],
		back: 'Back to sign in',
		busyTitle: 'Too many tries',
		busy: 'Wait a minute, then try again.',
		invalidTitle: 'Check the email address',
		invalid: 'Enter a valid email address.',
	},
	ar: {
		noPassword: 'لا كلمة مرور لهذا البريد بعد. اختر طريقة تسجيل الدخول:',
		link: 'أرسل لي رابط تسجيل الدخول',
		addPassword: 'إضافة كلمة مرور',
		hint: 'يعمل الرابط مرة واحدة ويسجّل دخولك. ولإضافة كلمة مرور، نرسل إليك أولًا رمزًا لنتأكد أن البريد بريدك.',
		setupTitle: 'إضافة كلمة مرور',
		setupText: 'سنرسل إليك رمزًا لنتأكد أن البريد بريدك، ثم نحفظ كلمة المرور ونسجّل دخولك.',
		sentTitle: 'تحقّق من بريدك',
		sent: (email: string) => [`إن كان بإمكان `, email, ` تسجيل الدخول برابط، فقد أرسلناه. يعمل مرة واحدة: افتحه لتسجيل الدخول. إن لم يصلك شيء خلال دقائق، فتحقّق من مجلد الرسائل غير المرغوب فيها، أو ارجع وأضف كلمة مرور.`],
		back: 'العودة إلى تسجيل الدخول',
		busyTitle: 'محاولات كثيرة',
		busy: 'انتظر دقيقة ثم حاول مرة أخرى.',
		invalidTitle: 'تحقّق من البريد الإلكتروني',
		invalid: 'أدخل بريدًا إلكترونيًا صحيحًا.',
	},
} as const;

export const signInLinkCopy = (lang: Lang) => COPY[lang];

/** Whether the email has a password: the one fact the options depend on (the same key the provider checks). */
export async function hasPassword(storage: StorageAdapter, email: string): Promise<boolean> {
	return (await Storage.get(storage, ['email', email.trim().toLowerCase(), 'password'])) !== undefined;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });
}

function readCookie(request: Request, name: string): string | null {
	for (const part of (request.headers.get('Cookie') ?? '').split(';')) {
		const [k, ...v] = part.trim().split('=');
		if (k === name) return v.join('=') || null;
	}
	return null;
}

function sameBytes(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/** The sign-in page's CSRF token: the browser's existing one, else a new one with its cookie. */
export function csrfFor(request: Request): { token: string; cookie: string | null } {
	const existing = readCookie(request, CSRF_COOKIE);
	if (existing && /^[0-9a-f]{64}$/.test(existing)) return { token: existing, cookie: null };
	const token = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
	const secure = !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(request.url);
	return { token, cookie: `${CSRF_COOKIE}=${token}; Path=/sign-in; Max-Age=3600; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}` };
}

/** Same-origin Origin when the browser sends one (fetch always does for a POST). */
function sameOrigin(request: Request): boolean {
	const origin = request.headers.get('Origin');
	return !origin || origin === new URL(request.url).origin;
}

/** Where "Back to sign in" goes: the sign-in page it came from (our own paths only), else the issuer's start. */
export function safeBack(value: unknown): string {
	if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/';
	return /^\/(password\/authorize|authorize)(\?|$)/.test(value) ? value : '/';
}

const PAGE_STYLE = `
[data-page="sign-in-link"] { display:flex; flex-direction:column; gap:1rem; }
[data-page="sign-in-link"] [data-component="button"] { width:100%; text-decoration:none; text-align:center; }
[data-page="sign-in-link"] bdi { overflow-wrap:anywhere; }
`;

async function respond(lang: Lang, theme: Theme | undefined, status: number, body: ReturnType<typeof html>): Promise<Response> {
	const page = Layout({ theme, locale: lang, children: html`<style>${raw(PAGE_STYLE)}</style>${body}` });
	return new Response(`<!DOCTYPE html>${await page.toString()}`, {
		status,
		headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Language': lang, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex' },
	});
}

function sentPage(lang: Lang, theme: Theme | undefined, email: string, back: string) {
	const t = COPY[lang];
	const [before, addr, after] = t.sent(email);
	return respond(
		lang,
		theme,
		200,
		html`<div data-component="form" data-page="sign-in-link" data-state="sent" role="status">
			<h1 data-component="title">${t.sentTitle}</h1>
			<p data-component="description">${before}<bdi dir="ltr">${addr}</bdi>${after}</p>
			<a data-component="button" data-color="ghost" href="${back}">${t.back}</a>
		</div>`
	);
}

function noticePage(lang: Lang, theme: Theme | undefined, status: number, title: string, text: string, back: string) {
	return respond(
		lang,
		theme,
		status,
		html`<div data-component="form" data-page="sign-in-link" data-state="${status === 429 ? 'busy' : 'invalid'}" role="alert">
			<h1 data-component="title">${title}</h1>
			<p data-component="description">${text}</p>
			<a data-component="button" data-color="ghost" href="${back}">${COPY[lang].back}</a>
		</div>`
	);
}

const langOf = (value: unknown): Lang => (value === 'ar' ? 'ar' : 'en');

/** Returns a response for /sign-in/method and /sign-in/link, or null for other paths. */
export async function routeSignInLink(request: Request, env: Env, ctx: ExecutionContext, requestId: string, theme?: Theme): Promise<Response | null> {
	const url = new URL(request.url);
	if (url.pathname !== SIGN_IN_METHOD_PATH && url.pathname !== SIGN_IN_LINK_PATH) return null;
	if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { Allow: 'POST' });
	if (!sameOrigin(request)) return json({ error: 'forbidden' }, 403);
	const ip = getClientIP(request);

	if (url.pathname === SIGN_IN_METHOD_PATH) {
		let email = '';
		try {
			const body = (await request.json()) as { email?: unknown };
			email = typeof body.email === 'string' ? normalizeInviteEmail(body.email) : '';
		} catch {
			// an empty or broken body is an invalid email
		}
		if (!plausibleEmail(email)) return json({ error: 'invalid_email' }, 400);
		if (
			!(await withinRateLimit(env.PASSWORD_IP_LIMITER, `signin:method:ip:${ip}`)) ||
			!(await withinRateLimit(env.PASSWORD_EMAIL_LIMITER, `signin:method:email:${await hashToken(email)}`))
		) {
			return json({ error: 'rate_limit_exceeded' }, 429, { 'Retry-After': String(RATE_LIMIT_PERIOD_SECONDS) });
		}
		return json({ password: await hasPassword(authStorage(env), email) });
	}

	// POST /sign-in/link: the form on the sign-in page
	const form = await request.formData().catch(() => null);
	const lang = langOf(form?.get('lang'));
	const back = safeBack(form?.get('back'));
	const field = form?.get('csrf');
	const cookie = readCookie(request, CSRF_COOKIE);
	if (!cookie || typeof field !== 'string' || !sameBytes(field, cookie)) return json({ error: 'forbidden' }, 403);
	const typed = form?.get('email');
	const email = typeof typed === 'string' ? normalizeInviteEmail(typed) : '';
	const t = COPY[lang];
	if (!plausibleEmail(email)) return noticePage(lang, theme, 400, t.invalidTitle, t.invalid, back);
	if (
		!(await withinRateLimit(env.SEND_CODE_LIMITER, `signin:link:ip:${ip}`)) ||
		!(await withinRateLimit(env.SEND_CODE_LIMITER, `signin:link:email:${await hashToken(email)}`))
	) {
		const busy = await noticePage(lang, theme, 429, t.busyTitle, t.busy, back);
		busy.headers.set('Retry-After', String(RATE_LIMIT_PERIOD_SECONDS));
		return busy;
	}
	// After the answer: the same page whether or not a link went out, in the same time
	ctx.waitUntil(
		emailLinkIfWaiting(env, request, requestId, email, lang, 'sign_in_page')
			.then((outcome) => logger.info('[sign-in-link] request handled', { requestId, outcome }))
			.catch((error) => logger.error('[sign-in-link] send failed', { requestId, error: String(error) }))
	);
	return sentPage(lang, theme, email, back);
}
