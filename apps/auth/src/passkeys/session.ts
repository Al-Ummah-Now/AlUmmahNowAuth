/**
 * Who is signed in on the auth host right now: the active account of the
 * shared browser session (`__session`), read by key from D1.
 *
 * Used by the add-a-passkey ceremony on `auth.*` (the after-sign-in card and
 * `/passkeys/setup`), which must only run for a recent, real sign-in.
 */
import { browserSessionRef } from '../handlers/logout-handler';
import { D1SessionAdapter } from '../adapters/session-adapter';

/** Adding a passkey needs a sign-in at most this old (AUTH-PASSKEYS). */
export const FRESH_SIGN_IN_MS = 15 * 60 * 1000;

export interface SignedInAccount {
	userId: string;
	tenantId: string;
	browserSessionId: string;
	email: string;
	roles: string[];
	/** epoch ms of the real sign-in behind this account session */
	authenticatedAt: number;
	amr: string[];
}

export async function signedInAccount(request: Request, env: { AUTH_DB: D1Database; SESSION_SECRET?: string }): Promise<SignedInAccount | null> {
	const ref = await browserSessionRef(request, env);
	if (!ref) return null;
	const sessions = new D1SessionAdapter(env.AUTH_DB);
	const browser = await sessions.getBrowserSession(ref.sid, ref.tid);
	if (!browser?.active_user_id) return null;
	const account = await sessions.getAccountSession(browser.id, browser.active_user_id);
	if (!account || Date.now() > account.expires_at) return null;
	const props = (account.subject_properties ?? {}) as Record<string, unknown>;
	const authenticatedAt = account.authenticated_at < 1e12 ? account.authenticated_at * 1000 : account.authenticated_at;
	return {
		userId: account.user_id,
		tenantId: ref.tid,
		browserSessionId: browser.id,
		email: typeof props.email === 'string' ? props.email : '',
		roles: Array.isArray(props.roles) ? (props.roles as string[]) : [],
		authenticatedAt,
		amr: Array.isArray(props.amr) ? (props.amr as string[]).filter((m) => typeof m === 'string') : [],
	};
}

export function isFresh(account: Pick<SignedInAccount, 'authenticatedAt'>, now = Date.now()): boolean {
	return now - account.authenticatedAt <= FRESH_SIGN_IN_MS;
}
