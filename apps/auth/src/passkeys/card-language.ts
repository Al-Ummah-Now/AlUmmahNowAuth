/**
 * The after-sign-in card in the other language (the shared header's language switch, wiki E10 "UNIFY").
 *
 * The card answers the issuer's POST, and what it continues to is the app's redirect with the
 * authorization code, which must never go into a link. So the card carries a signed token with what
 * it was rendered from, and the header's language switch posts that token here
 * (POST /passkeys/card/language): the same card, in the other language, with no OAuth values in
 * any URL. The token lives as long as the code (10 minutes, card.ts `ttl.code`).
 *
 * Without JavaScript the switch is a plain link to GET /passkeys/card/language?lang=…, which goes
 * to the signed-in setup page in that language. It never sees the code. A passkey needs JavaScript
 * anyway.
 */
import type { Theme } from '@al-ummah-now/openauth/ui/theme';
import { CARD_LANGUAGE_PATH, renderAddPasskeyPage, renderPasskeyNotice, type PageLocale } from './pages';

export { CARD_LANGUAGE_FORM_ID, CARD_LANGUAGE_PATH } from './pages';
const TOKEN_TTL_MS = 10 * 60 * 1000;

/** What the card was rendered from (no language: that is what changes) */
export interface CardLanguageClaims {
	u: string; // user id
	m: string; // email
	s: boolean; // staff
	g?: number; // staff grace, epoch seconds
	c: string; // the app's redirect (with the code)
	x: number; // expiry, ms
}

type SecretEnv = { SESSION_SECRET?: string };

async function key(env: SecretEnv): Promise<CryptoKey> {
	const secret = env.SESSION_SECRET || '0'.repeat(64);
	return crypto.subtle.importKey('raw', new TextEncoder().encode(`passkey-card-language:${secret}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

const b64url = (bytes: ArrayBuffer | Uint8Array) =>
	btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0));

export async function signCardLanguage(env: SecretEnv, claims: Omit<CardLanguageClaims, 'x'>, now = Date.now()): Promise<string> {
	const body = b64url(new TextEncoder().encode(JSON.stringify({ ...claims, x: now + TOKEN_TTL_MS })));
	const sig = await crypto.subtle.sign('HMAC', await key(env), new TextEncoder().encode(body));
	return `${body}.${b64url(sig)}`;
}

export async function readCardLanguage(env: SecretEnv, token: unknown, now = Date.now()): Promise<CardLanguageClaims | null> {
	if (typeof token !== 'string' || token.length > 4096) return null;
	const [body, sig, extra] = token.split('.');
	if (!body || !sig || extra !== undefined) return null;
	try {
		if (!(await crypto.subtle.verify('HMAC', await key(env), unb64url(sig), new TextEncoder().encode(body)))) return null;
		const claims = JSON.parse(new TextDecoder().decode(unb64url(body))) as CardLanguageClaims;
		if (typeof claims.x !== 'number' || claims.x <= now) return null;
		if (typeof claims.c !== 'string' || typeof claims.u !== 'string' || typeof claims.m !== 'string') return null;
		return claims;
	} catch {
		return null;
	}
}

const EXPIRED = {
	en: 'This page has expired. Sign in again to continue.',
	ar: 'انتهت صلاحية هذه الصفحة. سجّل الدخول من جديد للمتابعة.',
} as const;

/** The card for these claims, in `locale`, still carrying its token for the next switch */
export async function renderCardIn(locale: PageLocale, claims: CardLanguageClaims, token: string, theme?: Theme): Promise<Response> {
	const page = await renderAddPasskeyPage({
		locale,
		theme,
		mode: 'card',
		staff: claims.s,
		graceUntil: claims.g,
		needsCode: claims.s,
		email: claims.m,
		continueUrl: claims.c,
		autoContinue: true,
		lang: locale,
		languageToken: token,
	});
	const headers = new Headers(page.headers);
	// The header's no-script language link: this path, never the card's own (code-carrying) target
	headers.set('Content-Location', CARD_LANGUAGE_PATH);
	return new Response(page.body, { status: page.status, headers });
}

/** POST: the card in the other language. GET (no script): the setup page in that language. */
export async function handleCardLanguage(request: Request, env: SecretEnv, theme?: Theme): Promise<Response> {
	const url = new URL(request.url);
	if (request.method === 'GET') {
		const lang = url.searchParams.get('lang') === 'ar' ? 'ar' : 'en';
		return new Response(null, { status: 303, headers: { Location: `/passkeys/setup?lang=${lang}`, 'Cache-Control': 'no-store' } });
	}
	const form = await request.formData().catch(() => null);
	const locale: PageLocale = form?.get('lang') === 'ar' ? 'ar' : 'en';
	const token = form?.get('token');
	const claims = await readCardLanguage(env, token);
	if (!claims) {
		const notice = await renderPasskeyNotice({ locale, theme, message: EXPIRED[locale] });
		return new Response(notice.body, { status: 400, headers: notice.headers });
	}
	return renderCardIn(locale, claims, token as string, theme);
}
