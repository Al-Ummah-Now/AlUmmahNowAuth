/**
 * Passkey routes on the auth host (AUTH-PASSKEYS).
 *
 * Browser (auth origin, signed in with `__session`, JSON, Origin checked):
 *   GET  /passkeys/setup?return_to=&ticket=&lang=   add-a-passkey page
 *   POST /passkeys/register/options                  { code?, ticket? } → { options, token }
 *   POST /passkeys/register/verify                   { credential, token } → { ok, passkey }
 *   POST /passkeys/email-code                        staff's first passkey: email a code
 *   POST /passkeys/prompt/dismiss                    "Not now" on the after-sign-in card
 * Account hub (the user's own bearer token):
 *   GET    /account/passkeys
 *   PATCH  /account/passkeys/:id        { name }
 *   DELETE /account/passkeys/:id        soft delete; the last passkey of a staff account is refused
 *   POST   /account/passkeys/:id/restore
 * Auth admin (admin credentials; the router's admin guard runs first):
 *   GET    /admin/users/:id/passkeys
 *   DELETE /admin/users/:id/passkeys/:cid
 *   POST   /admin/users/:id/passkeys/setup-link
 *   GET    /admin/settings/staff-passkeys
 *   PUT    /admin/settings/staff-passkeys  { enforced }   Super Admin only; refused unless the admin has a passkey
 *
 * Adding a passkey needs a sign-in under 15 minutes old. A staff member's
 * first passkey also needs an emailed code or an admin's setup link, so a
 * stolen password alone can't enrol a thief's passkey. Every add/remove is
 * audited and emailed to the user.
 */
import { registrationOptions, verifyRegistration } from '@al-ummah-now/openauth/passkey';
import type { Theme } from '@al-ummah-now/openauth/ui/theme';
import { getAuditEmitter } from '../audit-emitter';
import { AuditEventSeverity, AuditEventType, createAuditEvent } from '../audit-events';
import { verifyAdminRequest } from '../auth-middleware';
import { logger } from '../logger';
import { getClientIP } from '../rate-limit';
import { verifyUserAccessToken } from '../routes/account-routes';
import { checkCode, recordCode } from '../security/password-attempts';
import { generateUnbiasedCode } from './util';
import { sendPasskeyEmail } from './email';
import { copyFor, renderAddPasskeyPage, renderPasskeyNotice, type PageLocale } from './pages';
import {
	isStaff,
	passkeyDeadline,
	readStaffPasskeySetting,
	userRoleNames,
	writeStaffPasskeySetting,
	STAFF_ROLES,
	normaliseRole,
	DEFAULT_GRACE_DAYS,
} from './policy';
import { hubUrl, issuerOrigin, rpId, rpName, rpOrigins, type RpEnv } from './rp';
import { isFresh, signedInAccount, type SignedInAccount } from './session';
import {
	MAX_PASSKEYS,
	cleanPasskeyName,
	countForUser,
	createSetupTicket,
	defaultPasskeyName,
	insertCredential,
	listForUser,
	peekSetupTicket,
	purgeRemovedForUser,
	removeCredential,
	renameCredential,
	restoreCredential,
	summaryOf,
	useSetupTicket,
	getCredential,
} from './store';

export interface PasskeyEnv extends RpEnv {
	AUTH_DB: D1Database;
	AUTH_STORAGE: KVNamespace;
	SESSION_SECRET?: string;
	RESEND_API_KEY?: unknown;
	PROFILE_APP_URL?: string;
	[key: string]: unknown;
}

export interface PasskeyRouteContext {
	request: Request;
	env: PasskeyEnv;
	ctx: ExecutionContext;
	requestId: string;
	theme?: Theme;
}

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

function pageLocale(url: URL): PageLocale {
	return url.searchParams.get('lang') === 'ar' ? 'ar' : 'en';
}

/** Same-origin POSTs only (CSRF): the browser routes are only called by our own pages. */
function sameOrigin(request: Request, env: PasskeyEnv): boolean {
	return request.headers.get('Origin') === issuerOrigin(env, request);
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
	try {
		const body = await request.json();
		return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function audit(rctx: PasskeyRouteContext, type: AuditEventType, userId: string, metadata: Record<string, unknown>) {
	rctx.ctx.waitUntil(
		getAuditEmitter()
			.emit(
				createAuditEvent(type, {
					severity: AuditEventSeverity.WARNING,
					userId,
					ipAddress: getClientIP(rctx.request),
					userAgent: rctx.request.headers.get('User-Agent'),
					requestId: rctx.requestId,
					metadata,
				})
			)
			.catch(() => undefined)
	);
}

async function userEmail(db: D1Database, userId: string): Promise<string | null> {
	const row = await db.prepare(`SELECT email FROM users WHERE id = ?1 AND deleted_at IS NULL`).bind(userId).first<{ email: string }>();
	return row?.email ?? null;
}

// ---------- signed registration tokens (stateless, 5 minutes) ----------

const REG_TTL_MS = 5 * 60 * 1000;

async function hmacKey(env: PasskeyEnv): Promise<CryptoKey> {
	const secret = env.SESSION_SECRET || '0'.repeat(64);
	return crypto.subtle.importKey('raw', new TextEncoder().encode(`passkey-registration:${secret}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

const b64url = (bytes: ArrayBuffer | Uint8Array) =>
	btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

interface RegistrationClaims {
	u: string; // user id
	s: string; // browser session id
	c: string; // challenge
	e: number; // expiry, ms
	k?: string; // setup ticket (raw), when the page came from an admin link
}

export async function signRegistration(env: PasskeyEnv, claims: RegistrationClaims): Promise<string> {
	const body = b64url(new TextEncoder().encode(JSON.stringify(claims)));
	const sig = await crypto.subtle.sign('HMAC', await hmacKey(env), new TextEncoder().encode(body));
	return `${body}.${b64url(sig)}`;
}

export async function readRegistration(env: PasskeyEnv, token: unknown, now = Date.now()): Promise<RegistrationClaims | null> {
	if (typeof token !== 'string' || !token.includes('.')) return null;
	const [body, sig] = token.split('.');
	const raw = Uint8Array.from(atob(sig.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0));
	const ok = await crypto.subtle.verify('HMAC', await hmacKey(env), raw, new TextEncoder().encode(body));
	if (!ok) return null;
	try {
		const claims = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/'))) as RegistrationClaims;
		return claims.e > now ? claims : null;
	} catch {
		return null;
	}
}

// ---------- who may add a passkey ----------

type Gate = { ok: true; needsCode: boolean; ticket?: string; roles: string[]; email: string } | { ok: false; error: string };

/**
 * Whether `account` may add a passkey now, and whether an emailed code is
 * needed first (staff without a passkey, no admin link, not signed in with a passkey).
 */
async function gate(env: PasskeyEnv, account: SignedInAccount | null, ticket: string | null): Promise<Gate> {
	if (!account) return { ok: false, error: 'not_signed_in' };
	if (!isFresh(account)) return { ok: false, error: 'stale_sign_in' };
	let validTicket: string | undefined;
	if (ticket) {
		const owner = await peekSetupTicket(env.AUTH_DB, ticket);
		if (!owner) return { ok: false, error: 'ticket_invalid' };
		if (owner !== account.userId) return { ok: false, error: 'ticket_other_account' };
		validTicket = ticket;
	}
	const [roles, count, email] = await Promise.all([
		userRoleNames(env.AUTH_DB, account.userId),
		countForUser(env.AUTH_DB, account.userId),
		userEmail(env.AUTH_DB, account.userId),
	]);
	if (!email) return { ok: false, error: 'not_signed_in' };
	if (count >= MAX_PASSKEYS) return { ok: false, error: 'limit' };
	const needsCode = isStaff(roles) && count === 0 && !account.amr.includes('passkey') && !validTicket;
	return { ok: true, needsCode, ticket: validTicket, roles, email };
}

/** Safe return target: our own hosts only (any *.alummahnow.net, localhost), else the hub. */
export function safeReturnTo(raw: string | null, env: PasskeyEnv): string {
	const fallback = hubUrl(env);
	if (!raw) return fallback;
	try {
		const url = new URL(raw);
		const host = url.hostname;
		const ours = host === 'alummahnow.net' || host.endsWith('.alummahnow.net') || host === 'localhost' || host === '127.0.0.1';
		if (!ours || (url.protocol !== 'https:' && host !== 'localhost' && host !== '127.0.0.1')) return fallback;
		return url.toString();
	} catch {
		return fallback;
	}
}

// ---------- handlers ----------

async function handleSetupPage(rctx: PasskeyRouteContext): Promise<Response> {
	const { request, env } = rctx;
	const url = new URL(request.url);
	const locale = pageLocale(url);
	const t = copyFor(locale);
	const returnTo = safeReturnTo(url.searchParams.get('return_to'), env);
	const ticket = url.searchParams.get('ticket');
	const account = await signedInAccount(request, env);
	const g = await gate(env, account, ticket);
	// Signing in again goes through the account hub, which comes back here
	const profile = (env.PROFILE_APP_URL || 'https://profile.auth.alummahnow.net/').replace(/\/$/, '');
	const back = new URL('/passkeys/add', profile);
	if (ticket) back.searchParams.set('ticket', ticket);
	back.searchParams.set('return_to', returnTo);
	if (locale === 'ar') back.searchParams.set('lang', 'ar');
	const reSignIn = `${profile}/login?prompt=login&return=${encodeURIComponent(back.pathname + back.search)}`;
	if ('error' in g) {
		const messages: Record<string, string> = {
			not_signed_in: t.signedOut,
			stale_sign_in: t.stale,
			ticket_invalid: t.ticketInvalid,
			ticket_other_account: t.ticketOtherAccount,
			limit: t.limit,
		};
		const action =
			g.error === 'not_signed_in'
				? { label: t.signIn, href: reSignIn.replace('prompt=login&', '') }
				: g.error === 'stale_sign_in' || g.error === 'ticket_other_account'
					? { label: t.signInAgain, href: reSignIn }
					: undefined;
		return renderPasskeyNotice({ locale, theme: rctx.theme, message: messages[g.error] ?? t.failed, action, back: returnTo });
	}
	const deadline = await passkeyDeadline(env.AUTH_DB, account!.userId, g.roles);
	return renderAddPasskeyPage({
		locale,
		theme: rctx.theme,
		mode: 'setup',
		staff: isStaff(g.roles),
		graceUntil: deadline,
		needsCode: g.needsCode,
		email: g.email,
		continueUrl: returnTo,
		ticket: g.ticket,
		lang: locale,
	});
}

async function handleRegisterOptions(rctx: PasskeyRouteContext): Promise<Response> {
	const { request, env } = rctx;
	const body = await readJson(request);
	const account = await signedInAccount(request, env);
	const ticket = typeof body.ticket === 'string' ? body.ticket : null;
	const g = await gate(env, account, ticket);
	if ('error' in g) return json({ error: g.error }, g.error === 'not_signed_in' ? 401 : 403);
	if (g.needsCode) {
		const code = typeof body.code === 'string' ? body.code.trim() : '';
		if (!/^\d{6}$/.test(code)) return json({ error: 'wrong_code' }, 403);
		const check = await checkCode(env.AUTH_DB, g.email, code);
		if (check !== 'ok') return json({ error: check === 'locked' ? 'locked_code' : 'wrong_code' }, 403);
	}
	const existing = await listForUser(env.AUTH_DB, account!.userId);
	const options = await registrationOptions({
		rpID: rpId(env, request),
		rpName: rpName(env),
		userID: account!.userId,
		userName: g.email,
		exclude: existing.map((r) => ({ id: r.id, transports: r.transports ? (JSON.parse(r.transports) as string[]) : undefined })),
	});
	const token = await signRegistration(env, {
		u: account!.userId,
		s: account!.browserSessionId,
		c: options.challenge,
		e: Date.now() + REG_TTL_MS,
		...(g.ticket ? { k: g.ticket } : {}),
	});
	return json({ options, token });
}

async function handleRegisterVerify(rctx: PasskeyRouteContext): Promise<Response> {
	const { request, env } = rctx;
	const body = await readJson(request);
	const claims = await readRegistration(env, body.token);
	if (!claims) return json({ error: 'failed' }, 400);
	const account = await signedInAccount(request, env);
	if (!account || account.userId !== claims.u || account.browserSessionId !== claims.s) return json({ error: 'not_signed_in' }, 401);
	if (!isFresh(account)) return json({ error: 'stale_sign_in' }, 403);
	if ((await countForUser(env.AUTH_DB, account.userId)) >= MAX_PASSKEYS) return json({ error: 'limit' }, 403);
	let reg;
	try {
		reg = await verifyRegistration({
			response: body.credential as never,
			challenge: claims.c,
			rpID: rpId(env, request),
			origins: rpOrigins(env, request),
		});
	} catch (error) {
		logger.warn('[passkeys] Registration not verified', { userId: account.userId, error: error instanceof Error ? error.message : String(error) });
		return json({ error: 'failed' }, 400);
	}
	if (await getCredential(env.AUTH_DB, reg.id)) return json({ error: 'exists' }, 409);
	// An admin setup link is used up by the passkey it enrolled
	if (claims.k && !(await useSetupTicket(env.AUTH_DB, claims.k, account.userId))) return json({ error: 'ticket_invalid' }, 403);
	const name = defaultPasskeyName(request.headers.get('User-Agent'), reg.deviceType === 'multiDevice');
	try {
		await insertCredential(env.AUTH_DB, account.userId, reg, name);
	} catch (error) {
		// Unique index on the credential id: the same authenticator twice
		logger.warn('[passkeys] Could not store passkey', { userId: account.userId, error: error instanceof Error ? error.message : String(error) });
		return json({ error: 'exists' }, 409);
	}
	await purgeRemovedForUser(env.AUTH_DB, account.userId);
	audit(rctx, AuditEventType.PASSKEY_ADDED, account.userId, { credentialId: reg.id, deviceType: reg.deviceType, viaSetupLink: !!claims.k });
	const email = await userEmail(env.AUTH_DB, account.userId);
	const locale = pageLocale(new URL(request.url));
	if (email) rctx.ctx.waitUntil(sendPasskeyEmail(env, email, { kind: 'added', name, hubUrl: hubUrl(env) }, locale));
	return json({ ok: true, passkey: { id: reg.id, name } });
}

async function handleEmailCode(rctx: PasskeyRouteContext): Promise<Response> {
	const { request, env } = rctx;
	const account = await signedInAccount(request, env);
	const g = await gate(env, account, null);
	if ('error' in g) return json({ error: g.error }, g.error === 'not_signed_in' ? 401 : 403);
	if (!g.needsCode) return json({ sent: false, error: 'code_failed' }, 400);
	const code = generateUnbiasedCode(6);
	await recordCode(env.AUTH_DB, g.email, code);
	const sent = await sendPasskeyEmail(env, g.email, { kind: 'code', code }, pageLocale(new URL(request.url)));
	return sent ? json({ sent: true }) : json({ sent: false, error: 'code_failed' }, 502);
}

async function handleDismiss(rctx: PasskeyRouteContext): Promise<Response> {
	const { request, env } = rctx;
	const account = await signedInAccount(request, env);
	if (!account) return json({ error: 'not_signed_in' }, 401);
	const { dismissPrompt } = await import('./store');
	await dismissPrompt(env.AUTH_DB, account.userId);
	return new Response(null, { status: 204 });
}

// ---------- account hub ----------

async function handleAccountPasskeys(rctx: PasskeyRouteContext, path: string): Promise<Response> {
	const { request, env } = rctx;
	const user = await verifyUserAccessToken(request, env as never);
	if (user instanceof Response) return user;
	const db = env.AUTH_DB;
	if (path === '/account/passkeys') {
		if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
		const rows = await listForUser(db, user.userId);
		const roles = await userRoleNames(db, user.userId);
		return json({ passkeys: rows.map(summaryOf), max: MAX_PASSKEYS, staff: isStaff(roles), signedInWithPasskey: !!user.amr?.includes('passkey') });
	}
	const m = path.match(/^\/account\/passkeys\/([A-Za-z0-9_-]{1,512})(\/restore)?$/);
	if (!m) return json({ error: 'not_found' }, 404);
	const id = m[1];
	if (m[2]) {
		if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
		if ((await countForUser(db, user.userId)) >= MAX_PASSKEYS) return json({ error: 'limit' }, 403);
		return (await restoreCredential(db, user.userId, id)) ? json({ ok: true }) : json({ error: 'not_found' }, 404);
	}
	if (request.method === 'PATCH') {
		const name = cleanPasskeyName((await readJson(request)).name);
		if (!name) return json({ error: 'invalid_name' }, 400);
		return (await renameCredential(db, user.userId, id, name)) ? json({ ok: true, name }) : json({ error: 'not_found' }, 404);
	}
	if (request.method === 'DELETE') {
		const rows = await listForUser(db, user.userId);
		const row = rows.find((r) => r.id === id);
		if (!row) return json({ error: 'not_found' }, 404);
		if (rows.length === 1 && isStaff(await userRoleNames(db, user.userId))) return json({ error: 'last_staff_passkey' }, 409);
		await removeCredential(db, user.userId, id);
		audit(rctx, AuditEventType.PASSKEY_REMOVED, user.userId, { credentialId: id, by: 'user' });
		const email = await userEmail(db, user.userId);
		const locale = new URL(request.url).searchParams.get('lang') === 'ar' ? 'ar' : 'en';
		if (email) rctx.ctx.waitUntil(sendPasskeyEmail(env, email, { kind: 'removed', name: row.name, byAdmin: false, hubUrl: hubUrl(env) }, locale));
		return json({ ok: true });
	}
	return json({ error: 'method_not_allowed' }, 405);
}

// ---------- auth admin ----------

async function adminActor(request: Request, env: PasskeyEnv): Promise<{ id: string; roles: string[] } | null> {
	try {
		const auth = await verifyAdminRequest(request.clone(), env as never);
		if (auth.type === 'm2m') return auth.actingUser ? { id: auth.actingUser.id, roles: auth.actingUser.roles } : null;
		return { id: auth.user.id, roles: auth.user.roles };
	} catch {
		return null;
	}
}

/** Staff without a passkey, for the enforcement panel: walks staff role assignments (role_id index), capped. */
async function staffWithoutPasskey(db: D1Database): Promise<{ staff: number; withoutPasskey: { id: string; email: string }[]; capped: boolean }> {
	const CAP = 500;
	const { results: roles } = await db.prepare(`SELECT id, name FROM rbac_roles LIMIT 200`).all<{ id: string; name: string }>();
	const staffRoleIds = (roles ?? []).filter((r) => (STAFF_ROLES as readonly string[]).includes(normaliseRole(r.name))).map((r) => r.id);
	const users = new Set<string>();
	let capped = false;
	for (const roleId of staffRoleIds) {
		const { results } = await db.prepare(`SELECT user_id FROM rbac_user_roles WHERE role_id = ?1 LIMIT ?2`).bind(roleId, CAP + 1).all<{ user_id: string }>();
		for (const r of results ?? []) users.add(r.user_id);
		if (users.size > CAP) {
			capped = true;
			break;
		}
	}
	const without: { id: string; email: string }[] = [];
	for (const id of [...users].slice(0, CAP)) {
		if ((await countForUser(db, id)) === 0) {
			const email = await userEmail(db, id);
			if (email) without.push({ id, email });
		}
	}
	return { staff: Math.min(users.size, CAP), withoutPasskey: without, capped };
}

async function handleAdmin(rctx: PasskeyRouteContext, path: string): Promise<Response | null> {
	const { request, env } = rctx;
	const db = env.AUTH_DB;
	if (path === '/admin/settings/staff-passkeys') {
		const actor = await adminActor(request, env);
		if (!actor) return json({ error: 'forbidden' }, 403);
		if (request.method === 'GET') {
			const setting = await readStaffPasskeySetting(db, 0);
			const summary = await staffWithoutPasskey(db);
			return json({ ...setting, ...summary, actorHasPasskey: (await countForUser(db, actor.id)) > 0 });
		}
		if (request.method === 'PUT') {
			if (!actor.roles.some((r) => normaliseRole(r) === 'super_admin')) return json({ error: 'super_admin_only' }, 403);
			const body = await readJson(request);
			const enforced = body.enforced === true;
			// Never lock the switcher out: they need a passkey before turning it on
			if (enforced && (await countForUser(db, actor.id)) === 0) return json({ error: 'actor_needs_passkey' }, 409);
			const current = await readStaffPasskeySetting(db, 0);
			const next = {
				enforced,
				// Keep the original time when it is already on, so the grace period does not restart
				enforcedAt: enforced ? (current.enforced && current.enforcedAt ? current.enforcedAt : Date.now()) : null,
				graceDays: DEFAULT_GRACE_DAYS,
			};
			await writeStaffPasskeySetting(db, next, actor.id);
			audit(rctx, AuditEventType.PASSKEY_ENFORCEMENT_CHANGED, actor.id, { enforced, enforcedAt: next.enforcedAt });
			return json(next);
		}
		return json({ error: 'method_not_allowed' }, 405);
	}
	const m = path.match(/^\/admin\/users\/([^/]+)\/passkeys(?:\/(setup-link|[A-Za-z0-9_-]{1,512}))?$/);
	if (!m) return null;
	const userId = decodeURIComponent(m[1]);
	const actor = await adminActor(request, env);
	if (!actor) return json({ error: 'forbidden' }, 403);
	if (!m[2]) {
		if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
		const rows = await listForUser(db, userId);
		return json({ passkeys: rows.map(summaryOf), staff: isStaff(await userRoleNames(db, userId)) });
	}
	if (m[2] === 'setup-link') {
		if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
		// Recovery is done by another admin, never for yourself (PK4)
		if (userId === actor.id) return json({ error: 'not_for_yourself' }, 403);
		const email = await userEmail(db, userId);
		if (!email) return json({ error: 'not_found' }, 404);
		const { token, expiresAt } = await createSetupTicket(db, userId, actor.id);
		const locale = (await readJson(request)).locale === 'ar' ? 'ar' : 'en';
		const link = new URL('/passkeys/setup', issuerOrigin(env, request));
		link.searchParams.set('ticket', token);
		if (locale === 'ar') link.searchParams.set('lang', 'ar');
		const sent = await sendPasskeyEmail(env, email, { kind: 'setup-link', link: link.toString(), expiresAt }, locale);
		audit(rctx, AuditEventType.PASSKEY_SETUP_LINK_SENT, userId, { by: actor.id, expiresAt, sent });
		return json({ ok: true, sent, expiresAt });
	}
	if (request.method !== 'DELETE') return json({ error: 'method_not_allowed' }, 405);
	const rows = await listForUser(db, userId);
	const row = rows.find((r) => r.id === m[2]);
	if (!row) return json({ error: 'not_found' }, 404);
	await removeCredential(db, userId, row.id);
	audit(rctx, AuditEventType.PASSKEY_REMOVED, userId, { credentialId: row.id, by: actor.id });
	const email = await userEmail(db, userId);
	if (email) rctx.ctx.waitUntil(sendPasskeyEmail(env, email, { kind: 'removed', name: row.name, byAdmin: true, hubUrl: hubUrl(env) }, 'en'));
	return json({ ok: true });
}

/** Routes this module serves, or null to fall through. */
export async function routePasskeys(rctx: PasskeyRouteContext): Promise<Response | null> {
	const { request, env } = rctx;
	const path = new URL(request.url).pathname;
	if (path === '/passkeys/setup') {
		if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
		return handleSetupPage(rctx);
	}
	if (path.startsWith('/passkeys/')) {
		if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
		if (!sameOrigin(request, env)) return json({ error: 'forbidden' }, 403);
		switch (path) {
			case '/passkeys/register/options':
				return handleRegisterOptions(rctx);
			case '/passkeys/register/verify':
				return handleRegisterVerify(rctx);
			case '/passkeys/email-code':
				return handleEmailCode(rctx);
			case '/passkeys/prompt/dismiss':
				return handleDismiss(rctx);
		}
		return json({ error: 'not_found' }, 404);
	}
	if (path === '/account/passkeys' || path.startsWith('/account/passkeys/')) return handleAccountPasskeys(rctx, path);
	if (path === '/admin/settings/staff-passkeys' || /^\/admin\/users\/[^/]+\/passkeys/.test(path)) return handleAdmin(rctx, path);
	return null;
}
