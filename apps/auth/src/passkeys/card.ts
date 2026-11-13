/**
 * The after-sign-in card (AUTH-PASSKEYS PK1): after an interactive sign-in,
 * a user without a passkey sees "Sign in faster next time: add a passkey"
 * before going on to the app. At most once every 30 days ("Not now"); staff
 * see it on every sign-in until they have one (Continue, no snooze).
 *
 * The authorization code is already issued when the card shows, so Auth sets
 * the issuer's code lifetime to 10 minutes (`ttl.code`).
 *
 * Shown when the PASSKEY_PROMPT var is "on" (QA, stage, production; off on
 * the local stack and in unit tests, so other suites' sign-ins go straight
 * to their app). Never for silent sign-on or test accounts (E2E and QA seed
 * domains). An address whose local part starts with `pk-` (or has `+pk-`/`-pk-`,
 * as E2E run users `e2e+<run>-<n>-pk-name@…` do)
 * always gets it: the passkey specs opt in that way.
 */
import type { Theme } from '@al-ummah-now/openauth/ui/theme';
import { renderAddPasskeyPage, type PageLocale } from './pages';
import { isStaff } from './policy';
import { countForUser, promptDismissedAt, PROMPT_SNOOZE_MS } from './store';

const TEST_DOMAINS = ['e2e.alummahnow.net', 'delivered.resend.dev'];

/** A passkey spec's account: always offered the card. */
export function optsIntoCard(email: string): boolean {
	const local = email.toLowerCase().split('@')[0] ?? '';
	return /(^|[+-])pk-/.test(local);
}

export function isTestAccount(email: string): boolean {
	const domain = email.toLowerCase().split('@')[1];
	return !!domain && TEST_DOMAINS.includes(domain);
}

/** Whether this sign-in may be offered the card at all (before the D1 checks). */
export function cardEnabledFor(env: { PASSKEY_PROMPT?: string }, email: string): boolean {
	if (optsIntoCard(email)) return true;
	return env.PASSKEY_PROMPT === 'on' && !isTestAccount(email);
}

export interface CardInput {
	db: D1Database;
	env: { PASSKEY_PROMPT?: string };
	provider: string;
	userId: string;
	email: string;
	roles: string[];
	/** epoch seconds, staff only while enforcement is on */
	deadline?: number;
	locale: PageLocale;
	theme?: Theme;
	/** The issuer's redirect back to the app (with the code) */
	redirect: Response;
	now?: number;
}

/** The card page (carrying the redirect's cookies), or null to redirect at once. */
export async function afterSignInCard(input: CardInput): Promise<Response | null> {
	if (!cardEnabledFor(input.env, input.email)) return null;
	if (input.provider !== 'password' && input.provider !== 'passkey') return null;
	const location = input.redirect.headers.get('Location');
	if (!location || input.redirect.status < 300 || input.redirect.status >= 400) return null;
	if ((await countForUser(input.db, input.userId)) > 0) return null;
	const staff = isStaff(input.roles);
	if (!staff) {
		const dismissed = await promptDismissedAt(input.db, input.userId);
		if (dismissed !== null && (input.now ?? Date.now()) - dismissed < PROMPT_SNOOZE_MS) return null;
	}
	const page = await renderAddPasskeyPage({
		locale: input.locale,
		theme: input.theme,
		mode: 'card',
		staff,
		graceUntil: input.deadline,
		// Signed in with a password just now; a staff member's first passkey needs the emailed code
		needsCode: staff,
		email: input.email,
		continueUrl: location,
		lang: input.locale,
	});
	// Keep the issuer's cookies (the new __session, flow cleanup)
	const headers = new Headers(page.headers);
	for (const cookie of (input.redirect.headers as Headers & { getSetCookie(): string[] }).getSetCookie()) headers.append('Set-Cookie', cookie);
	return new Response(page.body, { status: 200, headers });
}
