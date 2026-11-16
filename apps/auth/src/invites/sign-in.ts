/**
 * Direct sign-in from an invite link (docs/USER_INVITES.md "The link").
 *
 * Spending the single-use link proves the person reads the invited inbox, the
 * same proof as an emailed code. So Continue signs the pre-provisioned account
 * in on the auth host and makes it the active account of this browser's
 * session (other signed-in accounts stay as they are; the invite is only ever
 * the invited account's), and sets the `__session` SSO cookie. The app's
 * sign-in then completes silently through single sign-on: the issuer runs the normal onSuccess (account state checks,
 * current roles) for the app that receives the code.
 */
import { Storage } from '@al-ummah-now/openauth/storage/storage';
import type { StorageAdapter } from '@al-ummah-now/openauth/storage/storage';
import { createSessionCookieHeader } from '@al-ummah-now/openauth/session/middleware';
import { isLocalhostUrl } from '@al-ummah-now/openauth/session/cookie';
import { DEFAULT_SESSION_CONFIG } from '@al-ummah-now/openauth/contracts/types';
import { D1SessionAdapter } from '../adapters/session-adapter';
import { countForUser } from '../passkeys/store';
import { sessionCookieKey } from '../utils/session-secret';
import { browserSessionRef } from '../handlers/logout-handler';

/** RFC 8176: a one-time secret delivered to the user (the emailed link). */
export const INVITE_AMR = ['otp'];

export interface InviteAccount {
	id: string;
	tenant_id: string;
	email: string;
	status: string;
	deleted_at: number | null;
}

/** The invite's account by primary key. */
export async function inviteAccount(db: D1Database, tenantId: string, userId: string): Promise<InviteAccount | null> {
	return db
		.prepare('SELECT id, tenant_id, email, status, deleted_at FROM users WHERE tenant_id = ?1 AND id = ?2')
		.bind(tenantId, userId)
		.first<InviteAccount>();
}

/**
 * Whether the account can sign in by itself: a password (one key in the
 * issuer storage) or a passkey (indexed by user). Without either, the invite
 * link is its only way in, so a spent link offers a fresh one instead of
 * "sign in".
 */
export async function hasSignInMethod(db: D1Database, storage: StorageAdapter, account: Pick<InviteAccount, 'id' | 'email'>): Promise<boolean> {
	if ((await countForUser(db, account.id)) > 0) return true;
	const email = account.email.toLowerCase();
	return (await Storage.get(storage, ['email', email, 'password'])) !== undefined;
}

/**
 * Signs the account in on this browser and makes it the active account.
 *
 * The browser's own session, when it has a valid one (the encrypted
 * `__session` cookie decrypts and its D1 row exists), gains this account the
 * same way the issuer's own sign-ins add one: every other account stays
 * signed in and untouched. A browser with no session gets a new one; a
 * session already holding the most accounts it allows is replaced by a new
 * one with only this account (never a block or a warning).
 * Either way the account is freshly authenticated (adding a passkey right
 * after needs a fresh sign-in). Returns the Set-Cookie header for `__session`.
 */
export async function startInviteSession(
	env: { AUTH_DB: D1Database; SESSION_SECRET?: string },
	request: Request,
	account: Pick<InviteAccount, 'id' | 'tenant_id' | 'email'>,
	clientId: string
): Promise<{ cookie: string; browserSessionId: string; joined: boolean }> {
	const sessions = new D1SessionAdapter(env.AUTH_DB);
	const params = {
		userId: account.id,
		subjectType: 'user',
		// The identity silent sign-on hands to onSuccess; roles are re-read there for each app
		subjectProperties: { id: account.id, email: account.email, tenantId: account.tenant_id, roles: [], permissions: [], amr: INVITE_AMR },
		refreshToken: crypto.randomUUID(),
		clientId,
		ttl: DEFAULT_SESSION_CONFIG.sessionLifetimeSeconds,
	};

	const ref = await browserSessionRef(request, env).catch(() => null);
	const existing = ref && ref.tid === account.tenant_id ? await sessions.getBrowserSession(ref.sid, ref.tid) : null;
	let browser = existing;
	let joined = false;
	if (existing) {
		try {
			await sessions.addAccountToSession({ browserSessionId: existing.id, ...params });
			joined = true;
		} catch (error) {
			// A full session (the most accounts one allows): replaced cleanly by a new one below
			if (!(error instanceof Error && error.message === 'max_accounts_exceeded')) throw error;
			browser = null;
		}
	}
	if (!browser) {
		browser = await sessions.createBrowserSession({
			tenantId: account.tenant_id,
			userAgent: request.headers.get('User-Agent') || 'unknown',
			ipAddress: request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() || 'unknown',
		});
		await sessions.addAccountToSession({ browserSessionId: browser.id, ...params });
	}
	const fresh = (await sessions.getBrowserSession(browser.id, account.tenant_id)) ?? browser;
	const cookie = await createSessionCookieHeader(fresh, sessionCookieKey(env), DEFAULT_SESSION_CONFIG.cookieName, undefined, !isLocalhostUrl(request.url));
	return { cookie, browserSessionId: browser.id, joined };
}
