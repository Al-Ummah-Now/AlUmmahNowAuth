/**
 * Request-level guard for the password provider's POSTs (AU-2).
 *
 * Wraps one request to /password/{authorize,register,change}:
 * - Workers Rate Limiting per client IP (every POST) and per email (when the
 *   form names one). Atomic per location, no KV writes.
 * - Password sign-in: a D1 slot per email is reserved before the provider
 *   checks the password and released when the sign-in succeeded
 *   (password-attempts.ts), so at most MAX_LOGIN_FAILURES guesses per window
 *   get through no matter how many run in parallel.
 * - `checkCode` backs the provider's hook: every submitted code is counted in D1.
 *
 * - Turnstile (security/turnstile.ts): sign-up and the password-reset / email-code
 *   sends always; sign-in once an email has TURNSTILE_AFTER_FAILURES failures.
 * - Production with TURNSTILE_MODE=enforce: command-line clients (curl, python-requests, …) are refused.
 *
 * A throttled request still goes to the provider, with the field it would check
 * blanked, so the user gets the normal page (their email kept) with a "too many
 * attempts" message and HTTP 429. The provider never sees the guess.
 */
import { getClientIP } from '../rate-limit';
import { logger } from '../logger';
import { checkCode, releaseLoginAttempt, reserveLoginSlot } from './password-attempts';
import {
	checkHuman,
	hasValidBypass,
	HUMAN_CHECK_FAILED,
	isBadUserAgent,
	recordAbuse,
	TURNSTILE_FIELD,
	turnstileMode,
	type TurnstileEnv,
} from './turnstile';

/** Sign-in asks for the Turnstile check from this many failed attempts in the window on. */
export const TURNSTILE_AFTER_FAILURES = 3;

type Lang = 'en' | 'ar';

const COPY = {
	throttled: {
		en: 'Too many attempts. Please wait a few minutes and try again, or reset your password.',
		ar: 'محاولات كثيرة جدًا. يُرجى الانتظار بضع دقائق ثم المحاولة مرة أخرى، أو إعادة تعيين كلمة المرور.',
	},
	codeLocked: {
		en: 'This code has expired or was entered wrongly too many times. Request a new code.',
		ar: 'انتهت صلاحية هذا الرمز أو أُدخل بشكل خاطئ مرات كثيرة. اطلب رمزًا جديدًا.',
	},
} as const;

/** Seconds a throttled client is told to wait (both limiters use a 60 s period). */
const RETRY_AFTER_SECONDS = 60;

const PASSWORD_POST = /^\/password\/(authorize|register|change)$/;

/**
 * The path as the issuer's router sees it. Hono matches routes on the
 * percent-decoded path, so `/password/%61uthorize` reaches the login route; the
 * guard must not miss it. Decoding every ASCII escape (including %2F, which Hono
 * leaves encoded) can only make the guard match more, never less.
 */
export function routedPath(pathname: string): string {
	return pathname.replace(/%([0-7][0-9a-f])/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/** The PasswordUI `copy` object; PasswordUI reads it on every render, so changes here show up. */
export type PasswordCopy = Record<string, string>;

/** Background work after the response (ExecutionContext.waitUntil) */
type WaitUntil = (promise: Promise<unknown>) => void;

export interface PasswordGuardEnv extends TurnstileEnv {
	AUTH_DB: D1Database;
	PASSWORD_IP_LIMITER?: RateLimit;
	PASSWORD_EMAIL_LIMITER?: RateLimit;
}

export interface PasswordGuard {
	/** The request to hand to the issuer (a throttled one has the checked field blanked). */
	request: Request;
	/** For PasswordProvider's `checkCode` hook. */
	checkCode: (email: string, code: string) => Promise<boolean>;
	/** Post-processing of the issuer's response. */
	finish: (response: Response) => Promise<Response>;
	/** Turnstile widget to add to the page this request renders (null: none). */
	widget: { action: string } | null;
}

/** The widget's action name per password page (shown in the Turnstile analytics). */
const WIDGET_ACTION: Record<string, string> = { authorize: 'sign_in', register: 'sign_up', change: 'password_reset' };
const PASSWORD_PAGE = /^\/password\/(authorize|register|change)$/;

function langOf(url: URL): Lang {
	return url.searchParams.get('lang') === 'ar' ? 'ar' : 'en';
}

async function underLimit(limiter: RateLimit | undefined, key: string): Promise<boolean> {
	if (!limiter) return true;
	try {
		return (await limiter.limit({ key })).success;
	} catch (error) {
		// The binding is a local counter; failing open here still leaves the D1 limits
		logger.error('Rate limiter failed', { error: error instanceof Error ? error.message : String(error) });
		return true;
	}
}

export async function guardPasswordRequest(
	request: Request,
	env: PasswordGuardEnv,
	url: URL,
	copy: PasswordCopy,
	waitUntil?: WaitUntil
): Promise<PasswordGuard> {
	const lang = langOf(url);
	const guard: PasswordGuard = {
		request,
		checkCode: async (email, code) => {
			const result = await checkCode(env.AUTH_DB, email, code);
			if (result === 'locked') copy.error_invalid_code = COPY.codeLocked[lang];
			return result === 'ok';
		},
		finish: async (response) => response,
		widget: null,
	};

	const page = PASSWORD_PAGE.exec(routedPath(url.pathname));
	const turnstileOn = page !== null && turnstileMode(env) !== 'off' && !(await hasValidBypass(env, request));
	// Sign-up and reset pages always carry the widget; sign-in only once it is needed (below)
	if (turnstileOn && page && page[1] !== 'authorize') guard.widget = { action: WIDGET_ACTION[page[1]] };

	const match = request.method === 'POST' ? PASSWORD_POST.exec(routedPath(url.pathname)) : null;
	if (!match) return guard;
	const step = match[1];

	let form: FormData;
	try {
		form = await request.clone().formData();
	} catch {
		return guard; // not a form post; the provider rejects it
	}
	const email = form.get('email')?.toString().trim().toLowerCase() || undefined;
	const action = form.get('action')?.toString();

	const endpoint = `auth.${WIDGET_ACTION[step]}`;
	const ip = getClientIP(request);

	// Command-line clients never fill in these forms. Production with Turnstile enforced only,
	// so tests and scripts against QA/stage are never refused
	if (env.ENVIRONMENT === 'production' && turnstileMode(env) === 'enforce' && isBadUserAgent(request.headers.get('User-Agent'))) {
		recordAbuse(env, endpoint, 'bad_user_agent');
		logger.warn('Password post refused: scripted client', { step });
		guard.request = new Request(request.url, { method: 'GET', headers: request.headers });
		guard.finish = async () => new Response('Forbidden', { status: 403, headers: { 'Content-Type': 'text/plain' } });
		return guard;
	}

	let throttled =
		!(await underLimit(env.PASSWORD_IP_LIMITER, `ip:${ip}`)) ||
		(email !== undefined && !(await underLimit(env.PASSWORD_EMAIL_LIMITER, `email:${email}`)));
	if (throttled) recordAbuse(env, endpoint, 'rate_limited');

	// Sends an email (sign-up code, reset code) or, on sign-in, follows failed attempts
	const sends = (step === 'register' && action !== 'verify') || (step === 'change' && action === 'code');
	const token = form.get(TURNSTILE_FIELD)?.toString();
	let refusedAsBot = false;

	let reserved = false;
	if (!throttled && step === 'authorize' && email) {
		const count = await reserveLoginSlot(env.AUTH_DB, email);
		reserved = count !== null;
		throttled = !reserved;
		if (reserved && turnstileOn) {
			// count includes this attempt: from the Nth failure on, the page carries the widget
			if (count! >= TURNSTILE_AFTER_FAILURES) guard.widget = { action: WIDGET_ACTION.authorize };
			if (count! > TURNSTILE_AFTER_FAILURES && !(await checkHuman(env, request, token, endpoint, { ip })).allowed) {
				refusedAsBot = true;
				reserved = false;
				// Not a password guess: give the slot back
				await releaseLoginAttempt(env.AUTH_DB, email).catch(() => undefined);
			}
		}
	} else if (!throttled && sends && turnstileOn) {
		refusedAsBot = !(await checkHuman(env, request, token, endpoint, { ip })).allowed;
	}

	if (throttled || refusedAsBot) {
		const message = refusedAsBot ? HUMAN_CHECK_FAILED[lang] : COPY.throttled[lang];
		if (throttled) logger.warn('Password attempt throttled', { step, action, hasEmail: email !== undefined });
		copy.error_invalid_password = message;
		copy.error_invalid_code = message;
		copy.error_invalid_email = message;
		if (step === 'authorize') {
			form.set('password', '');
		} else if (step === 'register' && action === 'register' && form.has('password')) {
			// The sign-up form: an empty email makes the provider show the message there
			form.set('email', '');
		} else if (step === 'register') {
			// On the code screen, "register" re-sends the code without reading the
			// email; an empty verify sends nothing and shows the throttled message
			form.set('action', 'verify');
			form.set('code', '');
			form.set('email', '');
		} else if (action === 'verify') {
			form.set('code', '');
		} else {
			form.set('email', ''); // change: "code" needs the email to send anything
		}
		const headers = new Headers(request.headers);
		headers.delete('content-type'); // the FormData body sets its own boundary
		headers.delete('content-length');
		guard.request = new Request(request.url, { method: 'POST', headers, body: form });
		guard.finish = async (response) => {
			if (refusedAsBot) return new Response(response.body, { status: 400, statusText: 'Bad Request', headers: response.headers });
			const out = new Response(response.body, { status: 429, statusText: 'Too Many Requests', headers: response.headers });
			out.headers.set('Retry-After', String(RETRY_AFTER_SECONDS));
			return out;
		};
		return guard;
	}

	if (reserved && email) {
		guard.finish = async (response) => {
			// Success redirects (to the app, or to the forced password change); a wrong
			// password re-renders the form. Only a success gives the slot back.
			if (response.status >= 300 && response.status < 400) {
				// The redirect need not wait for it (#804): until it lands the slot just
				// counts as in flight, which can only make the limit stricter
				const release = releaseLoginAttempt(env.AUTH_DB, email).catch((error: unknown) => {
					logger.error('Could not release a sign-in slot', { error: error instanceof Error ? error.message : String(error) });
				});
				if (waitUntil) waitUntil(release);
				else await release;
			}
			return response;
		};
	}
	return guard;
}
