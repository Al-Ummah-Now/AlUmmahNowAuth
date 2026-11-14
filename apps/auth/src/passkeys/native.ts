/**
 * Native passkey sign-in and registration for the native Studio and Admin apps
 * (wiki AUTH-PASSKEYS "Native apps").
 *
 * Sign-in (`/native/passkey/options`, `/native/passkey/verify`) is served by the
 * openauth issuer's `nativePasskey` option; this module gives it the accepted
 * clients, the origins and the rate limit. Registration is served here:
 *
 *   POST /native/passkey/register/options   Bearer → { challenge_id, publicKey }
 *   POST /native/passkey/register/verify    Bearer + { challenge_id, credential, name? } → { id, name, created_at }
 *
 * No cookies, no CORS, no Turnstile (native callers only, AlUmmahNow#1275).
 * Every D1 read is by key.
 */
import { registrationOptions, verifyRegistration, type RegisteredPasskey } from '@al-ummah-now/openauth/passkey';
import type { NativePasskeyOptions } from '@al-ummah-now/openauth/native-passkey';
import { Storage, type StorageAdapter } from '@al-ummah-now/openauth/storage/storage';
import { getAuditEmitter } from '../audit-emitter';
import { AuditEventSeverity, AuditEventType, createAuditEvent } from '../audit-events';
import { reportAuthError } from '../errors/report';
import { logger } from '../logger';
import { getClientIP, withinRateLimit, RATE_LIMIT_PERIOD_SECONDS } from '../rate-limit';
import { verifyUserAccessToken } from '../routes/account-routes';
import { isRevoked, readRevocationForRefresh } from '../revocation/revocation-list';
import { isRefusedAccountState, readAccountState } from '../security/account-status';
import { sendPasskeyEmail } from './email';
import { isStaff, userRoleNames } from './policy';
import { hubUrl, issuerOrigin, rpId, rpName, rpOrigins, type RpEnv } from './rp';
import { FRESH_SIGN_IN_MS } from './session';
import {
	MAX_PASSKEYS,
	cleanPasskeyName,
	countForUser,
	defaultPasskeyName,
	getCredential,
	insertCredential,
	listForUser,
	purgeRemovedForUser,
	touchCredential,
} from './store';

/** Ceremony and challenge lifetime for native apps (the platform sheets time out at 2 minutes). */
export const NATIVE_CHALLENGE_TTL_S = 120;

/**
 * The public native clients that may use native passkeys: Studio and Admin on
 * every platform, QA and prod/stage ids (migrations 0013, 0036, 0039, 0040).
 * Viewer and TV clients are not accepted. The row must also be enabled, have
 * no secret and `metadata.type = "native"`.
 */
export const NATIVE_PASSKEY_CLIENT_IDS: ReadonlySet<string> = new Set([
	// prod + stage
	'6f8073c6-754b-4d63-bf80-0546214e0d62', // Studio (iOS / Android)
	'950e2b3b-6353-4472-affe-7c1f57f4e6a4', // Studio (desktop)
	'95adb86e-fdfb-4955-984b-347aa16a5023', // Admin (iOS)
	'6a65d365-1352-4ffa-922f-4053d461ac3a', // Admin (macOS)
	'288b80b9-ecc6-4927-8b5a-bded5aa00e55', // Admin (Windows)
	'6634c4c9-a80d-4961-9427-d997349f8ea2', // Admin (Android)
	// QA
	'45364a42-21f4-4359-a76c-0a1e6615fd7b', // Studio (iOS / Android)
	'29b4792a-caad-4814-a83f-4337bc6a1aeb', // Studio (desktop)
	'77330b47-5747-4058-ba00-921e159f1ced', // Admin (iOS)
	'1c230211-7b90-4d0a-be9d-3068ebd79d5b', // Admin (macOS)
	'306b6f10-d9f0-4609-84a1-23c92da978e9', // Admin (Windows)
	'5b44a4f7-d369-4d12-bc69-028d0276604a', // Admin (Android)
]);

export interface NativeEnv extends RpEnv {
	AUTH_DB: D1Database;
	/** JSON { "<android package>": ["AA:BB:… SHA-256 of a signing certificate", …] } */
	ANDROID_APP_CERTS?: string;
	NATIVE_PASSKEY_LIMITER?: RateLimit;
	TOKEN_REVOCATIONS?: KVNamespace;
	[key: string]: unknown;
}

/**
 * The client's native redirect: its first registered private-use-scheme
 * redirect (`alummahnow-studio://auth/callback`), the one the app sends at /token.
 */
export function nativeRedirect(redirectUris: unknown): string | undefined {
	if (!Array.isArray(redirectUris)) return undefined;
	for (const uri of redirectUris) {
		if (typeof uri !== 'string') continue;
		const match = /^([a-z][a-z0-9+.-]*):\/\//i.exec(uri);
		if (match && !/^https?$/i.test(match[1])) return uri;
	}
	return undefined;
}

/** An accepted native client, its default redirect and every registered redirect, read by id. */
export async function nativeClient(db: D1Database, clientId: string): Promise<{ redirectURI: string; redirectURIs: string[] } | undefined> {
	if (!NATIVE_PASSKEY_CLIENT_IDS.has(clientId)) return undefined;
	const row = await db
		.prepare(`SELECT redirect_uris, metadata, client_secret_hash, enabled FROM oauth_clients WHERE id = ?1`)
		.bind(clientId)
		.first<{ redirect_uris: string | null; metadata: string | null; client_secret_hash: string | null; enabled: number }>();
	if (!row || row.enabled !== 1 || row.client_secret_hash) return undefined;
	try {
		const metadata = row.metadata ? (JSON.parse(row.metadata) as { type?: string }) : {};
		if (metadata.type !== 'native') return undefined;
		const registered: unknown = row.redirect_uris ? JSON.parse(row.redirect_uris) : [];
		const redirectURI = nativeRedirect(registered);
		if (!redirectURI || !Array.isArray(registered)) return undefined;
		// The app may name any of these on options (the Windows Studio app: its loopback redirect)
		return { redirectURI, redirectURIs: registered.filter((u): u is string => typeof u === 'string') };
	} catch {
		return undefined;
	}
}

/** "AA:BB:…" (or plain hex) SHA-256 → the base64url Credential Manager puts in `android:apk-key-hash:`. */
export function apkKeyHash(fingerprint: string): string | undefined {
	const hex = fingerprint.replace(/[:\s]/g, '');
	if (!/^[0-9a-fA-F]{64}$/.test(hex)) return undefined;
	const bytes = new Uint8Array(32);
	for (let i = 0; i < 32; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}

/** Every configured Android signing certificate as an origin (bad entries are skipped and logged). */
export function androidOrigins(env: Pick<NativeEnv, 'ANDROID_APP_CERTS'>): string[] {
	const raw = env.ANDROID_APP_CERTS;
	if (!raw) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		logger.error('[passkeys] ANDROID_APP_CERTS is not JSON');
		return [];
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
	const origins = new Set<string>();
	for (const list of Object.values(parsed as Record<string, unknown>)) {
		if (!Array.isArray(list)) continue;
		for (const fingerprint of list) {
			const hash = typeof fingerprint === 'string' ? apkKeyHash(fingerprint) : undefined;
			if (hash) origins.add(`android:apk-key-hash:${hash}`);
			else logger.warn('[passkeys] Skipping a malformed Android certificate fingerprint');
		}
	}
	return [...origins];
}

/** Origins accepted in a native ceremony: the web's, https://<RP id> (Apple, Windows), Android apps. */
export function nativeOrigins(env: NativeEnv, request: Request): string[] {
	const rp = rpId(env, request);
	const https = rp === 'localhost' ? [] : [`https://${rp}`];
	return [...new Set([...rpOrigins(env, request), ...https, ...androidOrigins(env)])];
}

function rateKey(route: string, request: Request, clientId: string): string {
	return `native-passkey:${route}:${getClientIP(request)}:${clientId}`;
}

/** The issuer's `nativePasskey` option for this request. */
export function nativePasskeyOptions(env: NativeEnv, ctx: ExecutionContext, requestId: string): NativePasskeyOptions {
	return {
		rpID: (req) => rpId(env, req),
		origins: (req) => nativeOrigins(env, req),
		store: {
			get: (id) => getCredential(env.AUTH_DB, id),
			touch: (id, counter) => touchCredential(env.AUTH_DB, id, counter),
		},
		client: (clientId) => nativeClient(env.AUTH_DB, clientId),
		rateLimit: ({ route, clientID, req }) => withinRateLimit(env.NATIVE_PASSKEY_LIMITER, rateKey(route, req, clientID)),
		retryAfter: RATE_LIMIT_PERIOD_SECONDS,
		challengeTTL: NATIVE_CHALLENGE_TTL_S,
		provider: 'passkey',
		onFailure: (reason) => logger.warn('[passkeys] Native sign-in refused', { reason }),
		// The reference rides on X-Error-Ref, so the 5xx wrapper does not report it again
		onError: (error, req) => reportAuthError(env as never, ctx, error, { route: new URL(req.url).pathname, method: req.method, requestId }),
	};
}

// ---------- registration (Bearer) ----------

export interface NativeRouteContext {
	request: Request;
	env: NativeEnv;
	ctx: ExecutionContext;
	requestId: string;
	storage: StorageAdapter;
	now?: number;
}

interface RegistrationRecord {
	challenge: string;
	userId: string;
	clientId: string;
	expires: number;
}

/** Inside the issuer's oauth:native-passkey range (swept with the codes, see token-cleanup.ts). */
export const nativeRegistrationKey = (id: string) => ['oauth:native-passkey', 'reg', id];

const NO_STORE = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), { status, headers: { ...NO_STORE, ...headers } });
const fail = (status: number, error: string, description: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
	json({ error, error_description: description, ...extra }, status, headers);

function randomId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
	try {
		const body = await request.json();
		return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

async function userEmail(db: D1Database, userId: string): Promise<string | null> {
	const row = await db.prepare(`SELECT email FROM users WHERE id = ?1 AND deleted_at IS NULL`).bind(userId).first<{ email: string }>();
	return row?.email ?? null;
}

interface SignedInCaller {
	ok: true;
	userId: string;
	clientId: string;
	amr: string[];
	email: string;
	roles: string[];
	count: number;
}
type Caller = SignedInCaller | { ok: false; response: Response };

/**
 * The signed-in caller of a registration route: a valid user access token of
 * an accepted native client, a sign-in under 15 minutes old and not revoked
 * (sign out everywhere, password change), an active account.
 */
async function caller(rctx: NativeRouteContext, route: string): Promise<Caller> {
	const { request, env } = rctx;
	const verified = await verifyUserAccessToken(request, env as never);
	if (verified instanceof Response) return { ok: false, response: fail(401, 'invalid_token', 'A valid access token is required.') };
	const clientId = verified.clientId ?? '';
	if (!(await withinRateLimit(env.NATIVE_PASSKEY_LIMITER, rateKey(route, request, clientId || verified.userId)))) {
		return {
			ok: false,
			response: fail(429, 'rate_limited', 'Too many requests. Try again later.', {}, { 'Retry-After': String(RATE_LIMIT_PERIOD_SECONDS) }),
		};
	}
	if (!(await nativeClient(env.AUTH_DB, clientId))) {
		return { ok: false, response: fail(400, 'invalid_client', 'This app cannot add a passkey here.') };
	}
	const now = rctx.now ?? Date.now();
	if (verified.authTime === undefined || now - verified.authTime * 1000 > FRESH_SIGN_IN_MS) {
		return { ok: false, response: fail(401, 'step_up_required', 'Sign in again to add a passkey.', { max_age: FRESH_SIGN_IN_MS / 1000 }) };
	}
	const [revocation, state, email, roles, count] = await Promise.all([
		readRevocationForRefresh({ kv: env.TOKEN_REVOCATIONS, db: env.AUTH_DB }, verified.userId),
		readAccountState(env.AUTH_DB, verified.userId),
		userEmail(env.AUTH_DB, verified.userId),
		userRoleNames(env.AUTH_DB, verified.userId),
		countForUser(env.AUTH_DB, verified.userId),
	]);
	// A revoked sign-in or a suspended/deleted account: the access token may not have expired yet
	if (isRevoked(revocation, { authTime: verified.authTime }) || isRefusedAccountState(state) || !email) {
		return { ok: false, response: fail(401, 'invalid_token', 'A valid access token is required.') };
	}
	return { ok: true, userId: verified.userId, clientId, amr: verified.amr ?? [], email, roles, count };
}

/**
 * Limits shared by options and verify: 10 passkeys (PK6); a staff member's first
 * passkey needs the emailed code, which only the web setup page asks for.
 */
function limits(rctx: NativeRouteContext, c: SignedInCaller): Response | null {
	// Same codes as the web's /passkeys/register/* (limit, exists)
	if (c.count >= MAX_PASSKEYS) return fail(403, 'limit', 'This account already has the most passkeys allowed.');
	if (isStaff(c.roles) && c.count === 0 && !c.amr.includes('passkey')) {
		return fail(403, 'email_code_required', 'Add your first passkey on the web; it asks for a code we email you.', {
			setup_url: `${issuerOrigin(rctx.env, rctx.request)}/passkeys/setup`,
		});
	}
	return null;
}

export async function handleNativeRegisterOptions(rctx: NativeRouteContext): Promise<Response> {
	const c = await caller(rctx, 'register-options');
	if ('response' in c) return c.response;
	const refused = limits(rctx, c);
	if (refused) return refused;
	const { env, request } = rctx;
	const existing = await listForUser(env.AUTH_DB, c.userId);
	const publicKey = await registrationOptions({
		rpID: rpId(env, request),
		rpName: rpName(env),
		userID: c.userId,
		userName: c.email,
		exclude: existing.map((r) => ({ id: r.id, transports: r.transports ? (JSON.parse(r.transports) as string[]) : undefined })),
		timeout: NATIVE_CHALLENGE_TTL_S * 1000,
	});
	const challengeId = randomId();
	const expires = (rctx.now ?? Date.now()) + NATIVE_CHALLENGE_TTL_S * 1000;
	await Storage.atomic(rctx.storage).set(
		nativeRegistrationKey(challengeId),
		{ challenge: publicKey.challenge, userId: c.userId, clientId: c.clientId, expires } satisfies RegistrationRecord,
		new Date(expires)
	);
	return json({ challenge_id: challengeId, publicKey });
}

export async function handleNativeRegisterVerify(rctx: NativeRouteContext): Promise<Response> {
	const c = await caller(rctx, 'register-verify');
	if ('response' in c) return c.response;
	const { env, request } = rctx;
	const body = await readJson(request);
	const challengeId = body?.challenge_id;
	const credential = body?.credential as { id?: unknown; type?: unknown; response?: unknown } | undefined;
	if (typeof challengeId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(challengeId)) {
		return fail(400, 'invalid_request', 'challenge_id is missing or malformed.');
	}
	if (!credential || typeof credential !== 'object' || typeof credential.id !== 'string' || credential.type !== 'public-key' || !credential.response) {
		return fail(400, 'invalid_request', 'credential is missing or malformed.');
	}
	// Single use, whatever happens next
	const record = (await Storage.atomic(rctx.storage).take(nativeRegistrationKey(challengeId))) as RegistrationRecord | undefined;
	const now = rctx.now ?? Date.now();
	if (!record || now > record.expires || record.userId !== c.userId || record.clientId !== c.clientId) {
		return fail(400, 'invalid_credential', 'The passkey could not be added. Try again.');
	}
	const refused = limits(rctx, c);
	if (refused) return refused;
	let reg: RegisteredPasskey;
	try {
		reg = await verifyRegistration({
			response: credential as never,
			challenge: record.challenge,
			rpID: rpId(env, request),
			origins: nativeOrigins(env, request),
		});
	} catch (error) {
		logger.warn('[passkeys] Native registration not verified', { userId: c.userId, error: error instanceof Error ? error.message : String(error) });
		return fail(400, 'invalid_credential', 'The passkey could not be added. Try again.');
	}
	if (await getCredential(env.AUTH_DB, reg.id)) return fail(409, 'exists', 'This passkey is already on your account.');
	const name = cleanPasskeyName(body?.name) ?? defaultPasskeyName(request.headers.get('User-Agent'), reg.deviceType === 'multiDevice');
	try {
		await insertCredential(env.AUTH_DB, c.userId, reg, name, now);
	} catch (error) {
		logger.warn('[passkeys] Could not store native passkey', { userId: c.userId, error: error instanceof Error ? error.message : String(error) });
		return fail(409, 'exists', 'This passkey is already on your account.');
	}
	await purgeRemovedForUser(env.AUTH_DB, c.userId);
	rctx.ctx.waitUntil(
		getAuditEmitter()
			.emit(
				createAuditEvent(AuditEventType.PASSKEY_ADDED, {
					severity: AuditEventSeverity.WARNING,
					userId: c.userId,
					ipAddress: getClientIP(request),
					userAgent: request.headers.get('User-Agent'),
					requestId: rctx.requestId,
					metadata: { credentialId: reg.id, deviceType: reg.deviceType, native: true, clientId: c.clientId },
				})
			)
			.catch(() => undefined)
	);
	const locale = /^ar\b/i.test(request.headers.get('Accept-Language') ?? '') ? 'ar' : 'en';
	rctx.ctx.waitUntil(sendPasskeyEmail(env as never, c.email, { kind: 'added', name, hubUrl: hubUrl(env) }, locale));
	return json({ id: reg.id, name, created_at: now });
}

/** Routes this module serves itself (the issuer serves options/verify). */
export function routeNativePasskeys(rctx: NativeRouteContext): Promise<Response> | null {
	const { pathname } = new URL(rctx.request.url);
	if (pathname !== '/native/passkey/register/options' && pathname !== '/native/passkey/register/verify') return null;
	if (rctx.request.method !== 'POST') return Promise.resolve(fail(405, 'invalid_request', 'Use POST.', {}, { Allow: 'POST' }));
	const run = pathname.endsWith('/options') ? handleNativeRegisterOptions : handleNativeRegisterVerify;
	return run(rctx).catch((error: unknown) => {
		const ref = reportAuthError(rctx.env as never, rctx.ctx, error, { route: pathname, method: 'POST', requestId: rctx.requestId });
		return fail(500, 'server_error', 'Something went wrong.', { reference: ref }, { 'X-Error-Ref': ref });
	});
}
