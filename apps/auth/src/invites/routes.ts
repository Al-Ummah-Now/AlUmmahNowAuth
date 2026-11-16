/**
 * Invite HTTP routes (docs/USER_INVITES.md).
 *
 * For registered client apps (the videos admin), client credentials (HTTP
 * Basic, the same check as /token) plus the invites:provision scope; a client
 * sees and changes only its own invites:
 *
 *   POST /provisioning/invites                pre-provision the account + invite, email it
 *   GET  /provisioning/invites?ids=a,b        status of these invites (the app's sync)
 *   POST /provisioning/invites/:id/resend     new link, emailed again (expiry extended)
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
import { inviteChannels, renderInviteEmail } from './email';
import { inviteCopy, pageLocale, renderInviteState, type InvitePageState } from './page';
import { claimInvitedAccount, InviteError, InviteService, newInviteToken, type Invite, type InviteActor, type InviteRow } from './service';
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

/** Emails the invite (or, for QA/stage E2E addresses, keeps the link in the test sink). */
export async function deliverInvite(env: Env, invite: Invite, link: string): Promise<{ sent: boolean; via: 'email' | 'e2e_sink' | 'none'; error?: string }> {
	if (isE2EAddress(invite.email) && (await shouldSinkCode(env, invite.email))) {
		await env.AUTH_STORAGE.put(`test:invite:${invite.email}`, JSON.stringify({ link, at: Date.now() }), { expirationTtl: SINK_TTL_SECONDS });
		return { sent: true, via: 'e2e_sink' };
	}
	try {
		const apiKey = await requireSecret(env.RESEND_API_KEY as never, 'RESEND_API_KEY', env as unknown as Record<string, unknown>);
		const email = renderInviteEmail({
			email: invite.email,
			name: invite.name,
			link,
			expiresAt: invite.expiresAt,
			note: invite.note,
			locale: invite.locale,
			channels: inviteChannels(invite.details),
		});
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
					delivery = await deliverInvite(env, result.invite, inviteLink(issuer, result.token, result.invite.locale));
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
				const delivery = await deliverInvite(env, invite, inviteLink(issuer, token, invite.locale));
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
	| { kind: 'setup'; row: InviteRow; account: InviteAccount }
	| { kind: 'active'; row: InviteRow; account: InviteAccount };

/** What this link can do now, from the invite and its account (all reads by key). */
async function linkState(env: Env, service: InviteService, token: string, signedInUserId: string | null): Promise<LinkState> {
	const row = await service.byToken(token);
	if (!row) return { kind: 'unknown' };
	if (row.deleted_at !== null) return { kind: 'withdrawn', row };
	const account = await inviteAccount(env.AUTH_DB, row.tenant_id, row.user_id);
	if (!account || account.deleted_at !== null || (account.status !== 'invited' && account.status !== 'active')) return { kind: 'withdrawn', row };
	const unspent = row.token_used_at === null && row.expires_at > Date.now();
	if (account.status === 'invited') return unspent ? { kind: 'usable', row, account } : { kind: 'setup', row, account };
	if (signedInUserId === account.id) return { kind: 'signed-in', row, account };
	// Active: the link signs in only while the account has no password and no passkey
	if (await hasSignInMethod(env.AUTH_DB, authStorage(env), account)) return { kind: 'active', row, account };
	return unspent ? { kind: 'usable', row, account } : { kind: 'setup', row, account };
}

/**
 * GET/POST /invite/:token — the link in the invite email — and
 * POST /invite/:token/send — "Email me a new link" on a used or expired link.
 */
export async function routeInvitePage(request: Request, env: Env, ctx: ExecutionContext, requestId: string, theme?: Theme): Promise<Response | null> {
	const url = new URL(request.url);
	const match = /^\/invite\/([^/]+)(\/send)?\/?$/.exec(url.pathname);
	if (!match) return null;
	const [, token, send] = match;
	const allowed = send ? 'POST' : 'GET, POST';
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
			case 'unknown':
				return page({ kind: 'unknown', homeUrl }, 410);
			case 'withdrawn':
				return page({ kind: 'withdrawn', homeUrl }, 410);
			case 'signed-in':
				return page({ kind: 'signed-in', email: s.account.email, continueUrl: appContinueUrl(s.row.continue_url, env) }, status);
			case 'active':
				return page({ kind: 'active', email: s.account.email, signInUrl: appContinueUrl(s.row.continue_url, env) }, status);
			case 'setup': {
				const csrf = csrfFor(request);
				return page({ kind: 'setup', email: s.account.email, action: `/invite/${token}/send${url.search}`, csrf: csrf.token }, status, csrf.cookies);
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

	if (send) {
		if (state.kind !== 'setup') return show(state);
		const { row, account } = state;
		// A link was emailed in the last few minutes and this one has not been used since: "we just sent one".
		// (A link used after the last email asks for the first new one at once; each send replaces this
		// link's token, so one old link can never send twice.)
		const sentSinceUse = row.last_sent_at !== null && (row.token_used_at === null || row.last_sent_at > row.token_used_at);
		if (sentSinceUse && Date.now() - row.last_sent_at! < SELF_SEND_COOLDOWN_MS) return page({ kind: 'cooldown', email: account.email });
		if (!(await withinRateLimit(env.SEND_CODE_LIMITER, `invite:send:ip:${ip}`))) return page({ kind: 'busy' }, 429);
		// Deliver first, store after: a link that never reached the inbox is never valid, and the
		// page never shows the new token (only the invited inbox gets it)
		const ttl = Number(env.INVITE_TTL_DAYS) || undefined;
		const fresh = await newInviteToken();
		const scoped = new InviteService(env.AUTH_DB, { tenantId: row.tenant_id, defaultTtlDays: ttl });
		const planned = InviteService.view({ ...row, locale: lang, expires_at: scoped.extendedExpiry(row.expires_at) });
		const delivery = await deliverInvite(env, planned, inviteLink(issuerOf(env, request), fresh.token, lang));
		// Same event as an admin's resend; the invitee asked for it from the link
		audit(AuditEventType.USER_INVITE_RESENT, row, { by: 'invitee', emailSent: delivery.sent, via: delivery.via, targetEmail: row.email });
		if (!delivery.sent) {
			const csrf = csrfFor(request);
			return page({ kind: 'send-failed', email: account.email, action: `/invite/${token}/send${url.search}`, csrf: csrf.token }, 502, csrf.cookies);
		}
		await scoped.rotateToken(row.id, { extend: true, locale: lang, allowAccepted: true, sent: true, preset: fresh });
		return page({ kind: 'sent', email: account.email });
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
	});
	const headers = new Headers(offer.headers);
	headers.set('Referrer-Policy', 'no-referrer');
	headers.set('X-Robots-Tag', 'noindex');
	headers.append('Set-Cookie', signedIn.cookie);
	headers.append('Set-Cookie', csrfCookie('', request, 0));
	return new Response(offer.body, { status: 200, headers });
}
