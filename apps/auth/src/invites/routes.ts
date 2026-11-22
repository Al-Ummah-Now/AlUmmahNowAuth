/**
 * Invite HTTP routes (docs/USER_INVITES.md).
 *
 * For registered client apps (the videos admin), client credentials (HTTP
 * Basic, the same check as /token) plus the invites:provision scope; a client
 * sees and changes only its own invites:
 *
 *   POST /provisioning/invites                pre-provision the account + invite, email it
 *   GET  /provisioning/invites?ids=a,b        status of these invites (the app's sync)
 *   POST /provisioning/invites/:id/resend     new link, emailed again (expiry extended); `video` (or null) replaces the
 *                                             details' video for this email (the videos admin reads it again at each send)
 *   POST /provisioning/invites/:id/link       {tokenHash}: the app's "copy link" token
 *   POST /provisioning/invites/:id/revoke     soft delete (restorable for 30 days)
 *   POST /provisioning/invites/:id/restore
 *   POST /provisioning/invites/:id/purge      {confirm: email}: queue for the cleanup now
 *
 * Public: GET /invite/:token (page), POST /invite/:token (spend the link, sign in,
 * offer a passkey, go on to the app), POST /invite/:token/send (a used or
 * expired link of an account with no way to sign in: email a fresh link).
 *
 * Every change is audit-logged; tokens and their hashes never are.
 */
import { createClientAuthMiddleware, type OAuthClient } from '../middleware/clientAuth';
import { withinRateLimit, RATE_LIMIT_PERIOD_SECONDS, getClientIP } from '../rate-limit';
import { emitAuditEvent } from '../audit-emitter';
import { AuditEventSeverity, AuditEventType } from '../audit-events';
import { logger } from '../logger';
import { isAllowedOrigin } from '../utils/cors';
import { isE2EAddress, markRunUser, shouldSinkCode, SINK_TTL_SECONDS, type RunUsersEnv } from '../utils/e2e-sink';
import { requireSecret } from '../utils/secrets';
import { signInFallbackUrl } from '../utils/sign-in-restart';
import SendEmail from '../email';
import { inviteChannels, inviteVideo, parseInviteCopy, renderInviteEmail, renderSignInLinkEmail } from './email';
import { inviteCopy, pageLocale, renderInviteState, type InvitePageState } from './page';
import { claimInvitedAccount, InviteError, InviteService, newInviteToken, normalizeInviteEmail, type Invite, type InviteActor, type InviteRow, type SupersededReason } from './service';
import { hashToken } from '../utils/crypto';
import { hasSignInMethod, inviteAccount, startInviteSession, type InviteAccount } from './sign-in';
import { signedInAccount } from '../passkeys/session';
import { renderAddPasskeyPage } from '../passkeys/pages';
import { authStorage } from '../storage/auth-storage';
import { sessionSecretUsable } from '../utils/session-secret';
import { createLoginSuccessEvent } from '../audit-events';
import { getAuditEmitter } from '../audit-emitter';
import type { Theme } from '@al-ummah-now/openauth/ui/theme';

export const INVITE_CLIENT_SCOPE = 'invites:provision';
const INVITE_FROM = 'Al Ummah Now <login@alummahnow.net>';
const JSON_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });
}

const tooMany = () =>
	json({ error: 'rate_limit_exceeded', error_description: `Too many requests. Try again in ${RATE_LIMIT_PERIOD_SECONDS} seconds.` }, 429, {
		'Retry-After': String(RATE_LIMIT_PERIOD_SECONDS),
	});

const clientAuth = createClientAuthMiddleware();

async function authenticate(request: Request, env: Env, ctx: ExecutionContext): Promise<{ ok: true; client: OAuthClient } | { ok: false; response: Response }> {
	let result: Awaited<ReturnType<typeof clientAuth>>;
	try {
		result = await clientAuth(request, env, ctx);
	} catch (error) {
		logger.warn('[invites] client authentication failed', { error: error instanceof Error ? error.message : String(error) });
		return { ok: false, response: json({ error: 'invalid_client', error_description: 'Client authentication failed' }, 401, { 'WWW-Authenticate': 'Basic realm="invites"' }) };
	}
	if (result.authenticated === false) return { ok: false, response: result.response };
	const scopes = Array.isArray(result.client.scopes) ? result.client.scopes : [];
	if (!scopes.includes(INVITE_CLIENT_SCOPE)) {
		return { ok: false, response: json({ error: 'insufficient_scope', error_description: `Client lacks the ${INVITE_CLIENT_SCOPE} scope` }, 403) };
	}
	return { ok: true, client: result.client };
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
	try {
		const body = await request.json();
		return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

const str = (value: unknown) => (typeof value === 'string' ? value : undefined);

/** The issuer origin links are made on. */
function issuerOf(env: Env, request: Request): string {
	try {
		if (env.OPENAUTH_ISSUER) return new URL(env.OPENAUTH_ISSUER).origin;
	} catch {
		// fall back to the request origin
	}
	return new URL(request.url).origin;
}

export function inviteLink(issuer: string, token: string, locale: string): string {
	return `${issuer}/invite/${token}${locale === 'ar' ? '?lang=ar' : ''}`;
}

/**
 * Where "Continue" goes: the app's sign-in (sent by the app), if it is one of
 * our origins (ALLOWED_ORIGINS; localhost outside production), else the
 * default sign-in page.
 */
export function safeContinueUrl(value: unknown, env: Env): string | null {
	if (typeof value !== 'string' || !value) return null;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return null;
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
	if (isAllowedOrigin(url.origin, env)) return url.toString();
	const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
	if (local && env.ENVIRONMENT !== 'production') return url.toString();
	return null;
}

/**
 * Emails the invite (or, for QA/stage E2E addresses, keeps the link in the test sink). `opts.video`, when
 * given (null too), is the video for this email instead of the one in the invite's details.
 * `opts.emailCopy` is the admin's wording from the request (videos admin › Settings › Emails); without
 * usable copy the built-in words are sent and that is logged, so a missing template is noticed.
 */
export async function deliverInvite(
	env: Env,
	invite: Invite,
	link: string,
	opts: { video?: unknown; emailCopy?: unknown; purpose?: 'invite' | 'sign-in' } = {}
): Promise<{ sent: boolean; via: 'email' | 'e2e_sink' | 'none'; error?: string }> {
	if (isE2EAddress(invite.email) && (await shouldSinkCode(env, invite.email))) {
		await env.AUTH_STORAGE.put(`test:invite:${invite.email}`, JSON.stringify({ link, at: Date.now(), purpose: opts.purpose ?? 'invite' }), { expirationTtl: SINK_TTL_SECONDS });
		return { sent: true, via: 'e2e_sink' };
	}
	try {
		const apiKey = await requireSecret(env.RESEND_API_KEY as never, 'RESEND_API_KEY', env as unknown as Record<string, unknown>);
		if (opts.purpose === 'sign-in') {
			// The sign-in page's "Email me a sign-in link": its own short email, never the invite wording
			const email = renderSignInLinkEmail({ email: invite.email, link, expiresAt: invite.expiresAt, locale: invite.locale });
			const result = await SendEmail({ apiKey, from: INVITE_FROM, to: invite.email, subject: email.subject, html: email.html, text: email.text });
			return result.success ? { sent: true, via: 'email' } : { sent: false, via: 'none', error: 'send_failed' };
		}
		const parsed = parseInviteCopy(opts.emailCopy, invite.locale);
		if ('reason' in parsed) logger.warn('[invites] Built-in invite copy used', { inviteId: invite.id, locale: invite.locale, reason: parsed.reason });
		const email = renderInviteEmail({
			email: invite.email,
			name: invite.name,
			link,
			expiresAt: invite.expiresAt,
			note: invite.note,
			locale: invite.locale,
			channels: inviteChannels(invite.details),
			video: inviteVideo('video' in opts ? opts.video : invite.details?.video),
		}, 'copy' in parsed ? parsed.copy : undefined);
		const result = await SendEmail({ apiKey, from: INVITE_FROM, to: invite.email, subject: email.subject, html: email.html, text: email.text });
		if (!result.success) return { sent: false, via: 'none', error: 'send_failed' };
		return { sent: true, via: 'email' };
	} catch (error) {
		logger.error('[invites] Invite email failed', { inviteId: invite.id, error: error instanceof Error ? error.message : String(error) });
		return { sent: false, via: 'none', error: 'send_failed' };
	}
}

function fail(error: unknown): Response {
	if (error instanceof InviteError) return json({ error: error.code, error_description: error.message, ...(error.extra ?? {}) }, error.status);
	throw error;
}

/** Returns a response for /provisioning/invites[/...] or null for other paths. */
export async function routeInviteProvisioning(request: Request, env: Env, ctx: ExecutionContext, requestId: string): Promise<Response | null> {
	const url = new URL(request.url);
	const match = /^\/provisioning\/invites(?:\/([^/]+)(?:\/(resend|link|revoke|restore|purge))?)?\/?$/.exec(url.pathname);
	if (!match) return null;
	const [, id, action] = match;
	const route = !id && request.method === 'POST' ? 'create' : !id && request.method === 'GET' ? 'list' : id && action && request.method === 'POST' ? action : null;
	if (!route) return json({ error: 'method_not_allowed' }, 405, { Allow: id ? 'POST' : 'GET, POST' });

	const auth = await authenticate(request, env, ctx);
	if (auth.ok === false) return auth.response;
	const client = auth.client;

	const writes = route !== 'list';
	if (!(await withinRateLimit(writes ? env.ADMIN_SENSITIVE_LIMITER : env.ADMIN_LIMITER, `invites:${writes ? 'write' : 'read'}:client:${client.id}`))) {
		return tooMany();
	}

	const service = new InviteService(env.AUTH_DB, { tenantId: client.tenant_id || 'default', defaultTtlDays: Number(env.INVITE_TTL_DAYS) || undefined });
	const body = writes ? await readJson(request) : {};
	const by = (body.actor && typeof body.actor === 'object' ? body.actor : {}) as Record<string, unknown>;
	const actor: InviteActor = { userId: str(by.id) || `client:${client.id}`, email: str(by.email) || '', clientId: client.id };
	const issuer = issuerOf(env, request);
	const audit = (eventType: AuditEventType, invite: Invite, extra: Record<string, unknown> = {}) =>
		ctx.waitUntil(
			emitAuditEvent({
				timestamp: new Date().toISOString(),
				eventType,
				severity: eventType === AuditEventType.USER_INVITE_REVOKED ? AuditEventSeverity.WARNING : AuditEventSeverity.INFO,
				userId: actor.userId,
				ipAddress: getClientIP(request),
				userAgent: request.headers.get('User-Agent'),
				requestId,
				success: true,
				errorMessage: null,
				metadata: { clientId: client.id, inviteId: invite.id, targetUserId: invite.userId, targetEmail: invite.email, actorEmail: actor.email, ...extra },
			})
		);

	try {
		switch (route) {
			case 'list': {
				const ids = (url.searchParams.get('ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
				const invites = (await service.byIds(ids)).filter((i) => i.clientId === client.id);
				return json({ invites });
			}
			case 'create': {
				const result = await service.create(
					{
						inviteId: str(body.inviteId) ?? '',
						userId: str(body.userId) ?? '',
						email: str(body.email) ?? '',
						name: str(body.name),
						locale: str(body.locale),
						note: str(body.note),
						expiresInDays: typeof body.expiresInDays === 'number' ? body.expiresInDays : undefined,
						continueUrl: safeContinueUrl(body.continueUrl, env),
						details: body.details && typeof body.details === 'object' ? (body.details as Record<string, unknown>) : undefined,
						roles: body.roles === undefined ? undefined : (body.roles as string[]),
					},
					actor
				);
				let delivery: Awaited<ReturnType<typeof deliverInvite>> = { sent: false, via: 'none' };
				if (result.created && result.token && body.sendEmail !== false) {
					delivery = await deliverInvite(env, result.invite, inviteLink(issuer, result.token, result.invite.locale), { emailCopy: body.emailCopy });
					if (delivery.sent) await service.markSent(result.invite.id);
				}
				if (result.created) {
					// An E2E run address invited on QA/stage/local is a run account like a signed-up one, so the
					// run's teardown (/test/run-users/delete) may delete it; a no-op anywhere else
					await markRunUser(env as unknown as RunUsersEnv, env.AUTH_DB, result.user, 'invite');
					audit(AuditEventType.USER_INVITED, result.invite, { emailSent: delivery.sent, via: delivery.via });
					logger.info('[invites] Invite created', { inviteId: result.invite.id, userId: result.user.id, emailSent: delivery.sent });
				}
				const fresh = await service.requireOwned(result.invite.id, client.id);
				return json({ invite: fresh, user: result.user, created: result.created, emailSent: delivery.sent, emailError: delivery.error ?? null }, result.created ? 201 : 200);
			}
			case 'resend': {
				await service.requireOwned(id!, client.id);
				const { invite, token } = await service.rotateToken(id!, { extend: true, locale: str(body.locale) });
				const delivery = await deliverInvite(env, invite, inviteLink(issuer, token, invite.locale), { ...('video' in body ? { video: body.video } : {}), emailCopy: body.emailCopy });
				if (delivery.sent) await service.markSent(invite.id);
				audit(AuditEventType.USER_INVITE_RESENT, invite, { emailSent: delivery.sent, via: delivery.via });
				return json({ invite: await service.requireOwned(id!, client.id), emailSent: delivery.sent, emailError: delivery.error ?? null });
			}
			case 'link': {
				await service.requireOwned(id!, client.id);
				const invite = await service.setLinkHash(id!, str(body.tokenHash) ?? '');
				audit(AuditEventType.USER_INVITE_LINK_CREATED, invite);
				return json({ invite });
			}
			case 'revoke': {
				await service.requireOwned(id!, client.id);
				const invite = await service.revoke(id!, actor, str(body.reason));
				audit(AuditEventType.USER_INVITE_REVOKED, invite, { reason: invite.deletedReason });
				return json({ invite });
			}
			case 'restore': {
				await service.requireOwned(id!, client.id);
				const invite = await service.restore(id!);
				audit(AuditEventType.USER_INVITE_RESTORED, invite);
				return json({ invite });
			}
			case 'purge': {
				await service.requireOwned(id!, client.id);
				const invite = await service.requestPurge(id!, actor, str(body.confirm));
				audit(AuditEventType.USER_INVITE_PURGE_REQUESTED, invite);
				return json({ invite });
			}
		}
		return null;
	} catch (error) {
		return fail(error);
	}
}

/** How long after any send (admin or invitee) "Email me a new link" waits. */
export const SELF_SEND_COOLDOWN_MS = 5 * 60 * 1000;
const CSRF_COOKIE = 'invite_csrf';

/** The app's sign-in for this invite, minus `prompt` (prompt=login would refuse the session we just made). */
export function appContinueUrl(continueUrl: string | null, env: Env): string {
	const safe = safeContinueUrl(continueUrl, env);
	if (!safe) return signInFallbackUrl(env);
	const url = new URL(safe);
	url.searchParams.delete('prompt');
	return url.toString();
}

function readCookie(request: Request, name: string): string | null {
	for (const part of (request.headers.get('Cookie') ?? '').split(';')) {
		const [k, ...v] = part.trim().split('=');
		if (k === name) return v.join('=') || null;
	}
	return null;
}

function csrfCookie(value: string, request: Request, maxAge = 3600): string {
	const secure = !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(request.url);
	return `${CSRF_COOKIE}=${value}; Path=/invite; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

/** The form's CSRF token: the browser's existing one (several tabs), else a new random one. */
function csrfFor(request: Request): { token: string; cookies: string[] } {
	const existing = readCookie(request, CSRF_COOKIE);
	if (existing && /^[0-9a-f]{64}$/.test(existing)) return { token: existing, cookies: [] };
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	const token = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
	return { token, cookies: [csrfCookie(token, request)] };
}

function sameBytes(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/**
 * A POST must come from our own page: same-origin Origin (when the browser
 * sends one) and the form field equal to the SameSite=Strict cookie.
 */
async function csrfOk(request: Request): Promise<boolean> {
	const origin = request.headers.get('Origin');
	if (origin && origin !== new URL(request.url).origin) return false;
	const cookie = readCookie(request, CSRF_COOKIE);
	if (!cookie) return false;
	let field: unknown;
	try {
		field = (await request.clone().formData()).get('csrf');
	} catch {
		return false;
	}
	return typeof field === 'string' && sameBytes(field, cookie);
}

type LinkState =
	| { kind: 'unknown' }
	| { kind: 'withdrawn'; row: InviteRow }
	| { kind: 'usable'; row: InviteRow; account: InviteAccount }
	| { kind: 'signed-in'; row: InviteRow; account: InviteAccount }
	| { kind: 'setup'; row: InviteRow; account: InviteAccount; why: 'used' | 'expired' }
	| { kind: 'superseded'; row: InviteRow; account: InviteAccount; reason: SupersededReason }
	| { kind: 'active'; row: InviteRow; account: InviteAccount };

/**
 * What this link can do now, from the invite and its account (all reads by key). A link a newer
 * email or "Copy link" replaced still finds its invite (migration 0043) and says so; a link that
 * matches nothing at all is 'unknown' (also links used before their hash was kept, AlUmmahNowAuth#434).
 */
async function linkState(env: Env, service: InviteService, token: string, signedInUserId: string | null): Promise<LinkState> {
	const current = await service.byToken(token);
	const replaced = current ? null : await service.bySupersededToken(token);
	const row = current ?? replaced?.row;
	if (!row) return { kind: 'unknown' };
	if (row.deleted_at !== null) return { kind: 'withdrawn', row };
	const account = await inviteAccount(env.AUTH_DB, row.tenant_id, row.user_id);
	if (!account || account.deleted_at !== null || (account.status !== 'invited' && account.status !== 'active')) return { kind: 'withdrawn', row };
	const unspent = current !== null && row.token_used_at === null && row.expires_at > Date.now();
	const stuck: LinkState = replaced
		? { kind: 'superseded', row, account, reason: replaced.reason }
		: { kind: 'setup', row, account, why: row.token_used_at !== null ? 'used' : 'expired' };
	if (account.status === 'invited') return unspent ? { kind: 'usable', row, account } : stuck;
	if (signedInUserId === account.id) return { kind: 'signed-in', row, account };
	// Active: the link signs in only while the account has no password and no passkey
	if (await hasSignInMethod(env.AUTH_DB, authStorage(env), account)) return { kind: 'active', row, account };
	return unspent ? { kind: 'usable', row, account } : stuck;
}

/**
 * Emails a fresh single-use link to `email` when an invited account there is waiting for one: status
 * invited, or active with no password and no passkey (the link is its only way in). Otherwise
 * nothing happens. Never says which: callers answer the same page either way, and run this after
 * the answer (ctx.waitUntil) so the response time doesn't tell either.
 *
 * Used by a link we can't match ("enter the invited address", by: invitee_request) and by the
 * sign-in page's "Email me a sign-in link" (by: sign_in_page, its own email wording). A link was
 * emailed in the last few minutes: no second one (SELF_SEND_COOLDOWN_MS). Deliver first, store
 * after: a link that never reached the inbox is never valid. Audited like an admin's resend.
 */
export async function emailLinkIfWaiting(
	env: Env,
	request: Request,
	requestId: string,
	email: string,
	lang: 'en' | 'ar',
	by: 'invitee_request' | 'sign_in_page'
): Promise<'sent' | 'not_waiting' | 'cooldown' | 'send_failed'> {
	const service = new InviteService(env.AUTH_DB);
	const row = await service.openByEmail(email);
	const account = row ? await inviteAccount(env.AUTH_DB, row.tenant_id, row.user_id) : null;
	const waiting =
		row !== null &&
		account !== null &&
		account.deleted_at === null &&
		(account.status === 'invited' || (account.status === 'active' && !(await hasSignInMethod(env.AUTH_DB, authStorage(env), account))));
	if (!waiting) return 'not_waiting';
	if (row!.last_sent_at !== null && Date.now() - row!.last_sent_at < SELF_SEND_COOLDOWN_MS) return 'cooldown';
	const ttl = Number(env.INVITE_TTL_DAYS) || undefined;
	const fresh = await newInviteToken();
	const scoped = new InviteService(env.AUTH_DB, { tenantId: row!.tenant_id, defaultTtlDays: ttl });
	const planned = InviteService.view({ ...row!, locale: lang, expires_at: scoped.extendedExpiry(row!.expires_at) });
	const delivery = await deliverInvite(env, planned, inviteLink(issuerOf(env, request), fresh.token, lang), { purpose: by === 'sign_in_page' ? 'sign-in' : 'invite' });
	await emitAuditEvent({
		timestamp: new Date().toISOString(),
		eventType: AuditEventType.USER_INVITE_RESENT,
		severity: AuditEventSeverity.INFO,
		userId: row!.user_id,
		ipAddress: getClientIP(request),
		userAgent: request.headers.get('User-Agent'),
		requestId,
		success: true,
		errorMessage: null,
		metadata: { inviteId: row!.id, clientId: row!.client_id, by, emailSent: delivery.sent, via: delivery.via, targetEmail: row!.email },
	}).catch(() => undefined);
	if (!delivery.sent) return 'send_failed';
	await scoped.rotateToken(row!.id, { extend: true, locale: lang, allowAccepted: true, sent: true, preset: fresh });
	return 'sent';
}

/** A plausible address (the check the browser's type=email does, without a backtracking regex). */
export function plausibleEmail(value: string): boolean {
	if (value.length > 254 || /\s/.test(value)) return false;
	const at = value.indexOf('@');
	return at > 0 && at === value.lastIndexOf('@') && value.indexOf('.', at + 2) > at + 1 && !value.endsWith('.');
}

/**
 * GET/POST /invite/:token — the link in the invite email — and
 * POST /invite/:token/send — "Email me a new link" on a used or expired link.
 */
export async function routeInvitePage(request: Request, env: Env, ctx: ExecutionContext, requestId: string, theme?: Theme): Promise<Response | null> {
	const url = new URL(request.url);
	const match = /^\/invite\/([^/]+)(?:\/(send|request))?\/?$/.exec(url.pathname);
	if (!match) return null;
	const [, token, sub] = match;
	const send = sub === 'send';
	const allowed = sub ? 'POST' : 'GET, POST';
	if (!allowed.split(', ').includes(request.method)) return json({ error: 'method_not_allowed' }, 405, { Allow: allowed });
	const ip = getClientIP(request);
	if (!(await withinRateLimit(env.PASSWORD_IP_LIMITER, `invite:ip:${ip}`))) {
		const r = await renderInviteState(pageLocale(url), { kind: 'busy' }, { theme, status: 429 });
		r.headers.set('Retry-After', String(RATE_LIMIT_PERIOD_SECONDS));
		return r;
	}

	const service = new InviteService(env.AUTH_DB);
	const current = await signedInAccount(request, env).catch(() => null);
	const state = await linkState(env, service, token, current?.userId ?? null);
	const lang = pageLocale(url, 'row' in state ? state.row.locale : null);
	const homeUrl = signInFallbackUrl(env);
	const pagePath = `/invite/${token}${url.search}`;
	const page = (s: InvitePageState, status = 200, cookies: string[] = []) => renderInviteState(lang, s, { theme, status, cookies });
	const audit = (eventType: AuditEventType, row: InviteRow, metadata: Record<string, unknown>) =>
		ctx.waitUntil(
			emitAuditEvent({
				timestamp: new Date().toISOString(),
				eventType,
				severity: AuditEventSeverity.INFO,
				userId: row.user_id,
				ipAddress: ip,
				userAgent: request.headers.get('User-Agent'),
				requestId,
				success: true,
				errorMessage: null,
				metadata: { inviteId: row.id, clientId: row.client_id, ...metadata },
			})
		);

	/** The page for a state, with a CSRF token on the pages that have a form. */
	const show = (s: LinkState, status = 200): Promise<Response> => {
		switch (s.kind) {
			case 'unknown': {
				const csrf = csrfFor(request);
				return page({ kind: 'unknown', signInUrl: homeUrl, action: `/invite/${token}/request${url.search}`, csrf: csrf.token }, status === 200 ? 410 : status, csrf.cookies);
			}
			case 'withdrawn':
				return page({ kind: 'withdrawn', homeUrl }, 410);
			case 'signed-in':
				return page({ kind: 'signed-in', email: s.account.email, continueUrl: appContinueUrl(s.row.continue_url, env) }, status);
			case 'active':
				return page({ kind: 'active', email: s.account.email, signInUrl: appContinueUrl(s.row.continue_url, env) }, status);
			case 'setup': {
				const csrf = csrfFor(request);
				return page({ kind: 'setup', email: s.account.email, why: s.why, action: `/invite/${token}/send${url.search}`, csrf: csrf.token }, status, csrf.cookies);
			}
			case 'superseded': {
				const csrf = csrfFor(request);
				return page({ kind: 'superseded', reason: s.reason, action: `/invite/${token}/send${url.search}`, csrf: csrf.token }, status, csrf.cookies);
			}
			case 'usable': {
				// Other accounts signed in on this browser change nothing: Continue adds this one beside them
				const csrf = csrfFor(request);
				return page({ kind: 'ready', email: s.account.email, action: pagePath, csrf: csrf.token }, status, csrf.cookies);
			}
		}
	};

	if (request.method === 'GET') return show(state);
	// A POST that is not from our page: show the page again (with a fresh form), never act
	if (!(await csrfOk(request))) return show(state, 403);

	/**
	 * Email a fresh single-use link to the invited inbox (never to anyone else): the same delivery
	 * and audit as an admin's resend. `shown` is the address the page may show (absent when the
	 * person has not proved the inbox, e.g. a replaced or unmatched link).
	 */
	const emailNewLink = async (row: InviteRow, account: InviteAccount, shown: string | undefined, by: string, again: string): Promise<Response | null> => {
		// A link was emailed in the last few minutes and this one has not been used since: "we just sent one".
		// (A link used after the last email asks for the first new one at once; each send replaces this
		// link's token, so one old link can never send twice.)
		// A replaced or unmatched link isn't the latest link, so its use says nothing: any recent send counts.
		const sentSinceUse = row.last_sent_at !== null && (by !== 'invitee' || row.token_used_at === null || row.last_sent_at > row.token_used_at);
		if (sentSinceUse && Date.now() - row.last_sent_at! < SELF_SEND_COOLDOWN_MS) return shown === undefined && by === 'invitee_request' ? null : page({ kind: 'cooldown', email: shown });
		// Deliver first, store after: a link that never reached the inbox is never valid, and the
		// page never shows the new token (only the invited inbox gets it)
		const ttl = Number(env.INVITE_TTL_DAYS) || undefined;
		const fresh = await newInviteToken();
		const scoped = new InviteService(env.AUTH_DB, { tenantId: row.tenant_id, defaultTtlDays: ttl });
		const planned = InviteService.view({ ...row, locale: lang, expires_at: scoped.extendedExpiry(row.expires_at) });
		const delivery = await deliverInvite(env, planned, inviteLink(issuerOf(env, request), fresh.token, lang));
		// Same event as an admin's resend; the invitee asked for it
		audit(AuditEventType.USER_INVITE_RESENT, row, { by, emailSent: delivery.sent, via: delivery.via, targetEmail: row.email });
		if (!delivery.sent) {
			if (by === 'invitee_request') return null;
			const csrf = csrfFor(request);
			return page({ kind: 'send-failed', email: shown, action: again, csrf: csrf.token }, 502, csrf.cookies);
		}
		await scoped.rotateToken(row.id, { extend: true, locale: lang, allowAccepted: true, sent: true, preset: fresh });
		return shown === undefined && by === 'invitee_request' ? null : page({ kind: 'sent', email: shown });
	};

	if (send) {
		if (state.kind !== 'setup' && state.kind !== 'superseded') return show(state);
		if (!(await withinRateLimit(env.SEND_CODE_LIMITER, `invite:send:ip:${ip}`))) return page({ kind: 'busy' }, 429);
		const shown = state.kind === 'setup' ? state.account.email : undefined;
		const response = await emailNewLink(state.row, state.account, shown, state.kind === 'setup' ? 'invitee' : 'invitee_superseded', `/invite/${token}/send${url.search}`);
		return response ?? page({ kind: 'sent', email: shown });
	}

	if (sub === 'request') {
		// A link we can't match: the person types the invited address. The answer is the same whether
		// or not an invite is waiting for it, so the page never tells who was invited.
		if (state.kind !== 'unknown') return show(state);
		const typed = (await request.formData().catch(() => null))?.get('email');
		const email = typeof typed === 'string' ? normalizeInviteEmail(typed) : '';
		if (!plausibleEmail(email)) {
			const csrf = csrfFor(request);
			return page({ kind: 'unknown', signInUrl: homeUrl, action: `/invite/${token}/request${url.search}`, csrf: csrf.token, invalidEmail: true, email }, 400, csrf.cookies);
		}
		if (
			!(await withinRateLimit(env.SEND_CODE_LIMITER, `invite:request:ip:${ip}`)) ||
			!(await withinRateLimit(env.SEND_CODE_LIMITER, `invite:request:email:${await hashToken(email)}`))
		) {
			return page({ kind: 'busy' }, 429);
		}
		// Look up and send after the answer, so the response time doesn't tell either
		ctx.waitUntil(emailLinkIfWaiting(env, request, requestId, email, lang, 'invitee_request').catch((error) => logger.error('invite link request failed', { requestId, error: String(error) })));
		return page({ kind: 'requested', signInUrl: homeUrl });
	}

	// Continue: spend the link, sign in, make the invited account the active one
	if (state.kind !== 'usable') return show(state);
	if (!sessionSecretUsable(env)) {
		logger.error('[invites] SESSION_SECRET is not set; refusing to sign in from an invite link');
		return new Response('Server misconfigured', { status: 503 });
	}
	const { row, account } = state;
	// Single use: a concurrent second click loses here and sees the spent-link page
	if (!(await service.useToken(row.id))) return show(await linkState(env, service, token, current?.userId ?? null));
	audit(AuditEventType.USER_INVITE_OPENED, row, {});
	if (account.status === 'invited') {
		if (await claimInvitedAccount(env.AUTH_DB, row.tenant_id, account.id)) {
			audit(AuditEventType.USER_INVITE_ACCEPTED, row, { provider: 'invite_link' });
		}
		// An admin may have revoked it a moment ago: only an active account is signed in
		const now = await inviteAccount(env.AUTH_DB, row.tenant_id, account.id);
		if (!now || now.status !== 'active' || now.deleted_at !== null) return page({ kind: 'withdrawn', homeUrl }, 410);
	}
	const signedIn = await startInviteSession(env, request, account, row.client_id);
	ctx.waitUntil(
		getAuditEmitter().emit(
			createLoginSuccessEvent(account.email, account.id, {
				ipAddress: ip,
				userAgent: request.headers.get('User-Agent') ?? undefined,
				requestId,
				clientId: row.client_id,
				method: 'email_code',
			})
		)
	);
	logger.info('[invites] Signed in from an invite link', { inviteId: row.id, userId: account.id, joinedSession: signedIn.joined });

	const continueUrl = appContinueUrl(row.continue_url, env);
	const t = inviteCopy(lang);
	const offer = await renderAddPasskeyPage({
		locale: lang,
		theme,
		mode: 'card',
		staff: false,
		needsCode: false,
		email: account.email,
		continueUrl,
		autoContinue: true,
		lang,
		wording: { title: t.passkeyTitle, text: t.passkeyText, skip: t.skip },
		// The account may have no password: after a failure or Skip, say how to sign in next time
		noPasskeyNote: true,
	});
	const headers = new Headers(offer.headers);
	// The card answers this POST and can't be loaded again: the header's language switch (router.ts
	// withSignInChrome) opens the setup page, which goes on to the same app page. Only here: the
	// app's continue page carries nothing secret. The card after a normal sign-in continues to the
	// OAuth redirect (code, state), which must never be put in a URL; it names no twin.
	headers.set('Content-Location', `/passkeys/setup?${new URLSearchParams({ return_to: continueUrl, lang }).toString()}`);
	headers.set('Referrer-Policy', 'no-referrer');
	headers.set('X-Robots-Tag', 'noindex');
	headers.append('Set-Cookie', signedIn.cookie);
	headers.append('Set-Cookie', csrfCookie('', request, 0));
	return new Response(offer.body, { status: 200, headers });
}
