/**
 * What became of an account deletion (wiki guides/data-lifecycle.md).
 *
 * An app that deleted an account can lose the answer: no connection, or it was
 * killed. By then the account's refresh token is gone and nobody can sign in to
 * it again. So the app asks for a receipt first, while the person is signed in:
 *
 * - POST /account/deletion-receipt  the user's own token, signed in at most
 *   REAUTH_MAX_AGE_SECONDS ago: a receipt that lives 30 days
 * - GET  /account/status            `Authorization: Deletion-Receipt <receipt>`:
 *   whether that account is deleted, and nothing else
 *
 * A receipt is not a token: it opens nothing and says nothing but that one
 * fact. It is signed with a key of its own, derived (HKDF) from SESSION_SECRET
 * and named in the receipt by a version, so signing-key rotation does not touch
 * it. No access token, expired or not, is taken by the status route.
 */
import { logger } from '../logger';
import { RATE_LIMIT_PERIOD_SECONDS, getClientIP, withinRateLimit } from '../rate-limit';
import { sessionSecretUsable } from '../utils/session-secret';
import { requireRecentSignIn, verifyUserAccessToken } from './account-routes';

export const RECEIPT_TTL_SECONDS = 30 * 24 * 60 * 60;
export const RECEIPT_SCHEME = 'Deletion-Receipt';
/** The current key and format; a receipt of another version is refused. */
const VERSION = 'adr1';
const PURPOSE = 'deletion-status';
const KEY_INFO = 'al-ummah-now/auth/deletion-receipt/v1';
const MAX_RECEIPT_LENGTH = 1024;

interface ReceiptClaims {
	typ: typeof PURPOSE;
	/** This issuer: a receipt of another environment is refused */
	aud: string;
	sub: string;
	jti: string;
	iat: number;
	exp: number;
}

type ReceiptEnv = Pick<Env, 'SESSION_SECRET' | 'OPENAUTH_ISSUER' | 'ENVIRONMENT'>;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });

const b64url = (bytes: ArrayBuffer | Uint8Array) =>
	btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0));
const utf8 = (s: string) => new TextEncoder().encode(s);
const audience = (env: ReceiptEnv) => env.OPENAUTH_ISSUER || 'http://localhost:3301';

/** Signs receipts and nothing else. */
async function receiptKey(env: ReceiptEnv): Promise<CryptoKey> {
	const secret = await crypto.subtle.importKey('raw', utf8(env.SESSION_SECRET || '0'.repeat(64)), 'HKDF', false, ['deriveKey']);
	return crypto.subtle.deriveKey(
		{ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: utf8(KEY_INFO) },
		secret,
		{ name: 'HMAC', hash: 'SHA-256', length: 256 },
		false,
		['sign', 'verify'],
	);
}

export async function signReceipt(env: ReceiptEnv, userId: string, now = Date.now()): Promise<{ receipt: string; expiresAt: number }> {
	const iat = Math.floor(now / 1000);
	const claims: ReceiptClaims = { typ: PURPOSE, aud: audience(env), sub: userId, jti: crypto.randomUUID(), iat, exp: iat + RECEIPT_TTL_SECONDS };
	const body = `${VERSION}.${b64url(utf8(JSON.stringify(claims)))}`;
	const signature = await crypto.subtle.sign('HMAC', await receiptKey(env), utf8(body));
	return { receipt: `${body}.${b64url(signature)}`, expiresAt: claims.exp * 1000 };
}

/** The account a receipt is for; null when it is not a receipt of ours that is still valid. */
export async function readReceipt(env: ReceiptEnv, receipt: string, now = Date.now()): Promise<string | null> {
	if (receipt.length > MAX_RECEIPT_LENGTH) return null;
	const [version, payload, signature, extra] = receipt.split('.');
	if (version !== VERSION || !payload || !signature || extra !== undefined) return null;
	try {
		// The signature first: nothing in it is read before
		if (!(await crypto.subtle.verify('HMAC', await receiptKey(env), unb64url(signature), utf8(`${version}.${payload}`)))) return null;
		const claims = JSON.parse(new TextDecoder().decode(unb64url(payload))) as Partial<ReceiptClaims>;
		if (claims.typ !== PURPOSE || claims.aud !== audience(env)) return null;
		if (typeof claims.sub !== 'string' || !claims.sub || typeof claims.iat !== 'number' || typeof claims.exp !== 'number') return null;
		const seconds = now / 1000;
		if (seconds >= claims.exp || claims.exp - claims.iat > RECEIPT_TTL_SECONDS || claims.iat > seconds + 60) return null;
		return claims.sub;
	} catch {
		return null;
	}
}

/** Whether the account is deleted; null when there is no such account (never, or purged). */
async function isDeleted(db: D1Database, userId: string): Promise<boolean | null> {
	const row = await db.prepare('SELECT id, status, deleted_at FROM users WHERE id = ?').bind(userId).first<{ id: string; status: string; deleted_at: number | null }>();
	return row ? row.status === 'deleted' || row.deleted_at !== null : null;
}

const tooMany = () => json({ error: 'rate_limited', error_description: 'Too many requests. Try again later.' }, 429, { 'Retry-After': String(RATE_LIMIT_PERIOD_SECONDS) });
const unavailable = () => json({ error: 'temporarily_unavailable', error_description: 'Try again in a moment.' }, 503);

export async function handleDeletionReceipt(request: Request, env: Env): Promise<Response> {
	// Without the secret the key is public (utils/session-secret.ts)
	if (!sessionSecretUsable(env)) return unavailable();
	const user = await verifyUserAccessToken(request, env);
	if (user instanceof Response) return user;
	const stale = requireRecentSignIn(user);
	if (stale) return stale;
	if (!(await withinRateLimit(env.ACCOUNT_DELETION_LIMITER, `deletion-receipt:${user.userId}`))) return tooMany();
	if ((await isDeleted(env.AUTH_DB, user.userId)) !== false) return json({ error: 'not_found', error_description: 'Account not found' }, 404);
	return json(await signReceipt(env, user.userId));
}

export async function handleAccountStatus(request: Request, env: Env): Promise<Response> {
	if (!sessionSecretUsable(env)) return unavailable();
	// Counted before anything is verified, so guesses cost nothing more
	if (!(await withinRateLimit(env.ACCOUNT_DELETION_LIMITER, `account-status:${getClientIP(request)}`))) return tooMany();
	const header = request.headers.get('Authorization') ?? '';
	const receipt = header.startsWith(`${RECEIPT_SCHEME} `) ? header.slice(RECEIPT_SCHEME.length + 1).trim() : '';
	const userId = receipt ? await readReceipt(env, receipt) : null;
	if (!userId) {
		logger.info('[account] Deletion status asked without a valid receipt');
		return json({ error: 'receipt_invalid', error_description: 'A valid deletion receipt is required' }, 401, { 'WWW-Authenticate': RECEIPT_SCHEME });
	}
	// A receipt is only made for an account that exists: one without a row has been purged since
	return json({ deleted: (await isDeleted(env.AUTH_DB, userId)) ?? true });
}
