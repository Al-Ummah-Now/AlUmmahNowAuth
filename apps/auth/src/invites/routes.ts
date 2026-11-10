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
 * Public: GET /invite/:token (page), POST /invite/:token (spend, go to sign-in).
 *
 * Every change is audit-logged; tokens and their hashes never are.
 */
import { createClientAuthMiddleware, type OAuthClient } from '../middleware/clientAuth';
import { withinRateLimit, RATE_LIMIT_PERIOD_SECONDS, getClientIP } from '../rate-limit';
import { emitAuditEvent } from '../audit-emitter';
import { AuditEventSeverity, AuditEventType } from '../audit-events';
import { logger } from '../logger';
import { isAllowedOrigin } from '../utils/cors';
import { isE2EAddress, shouldSinkCode, SINK_TTL_SECONDS } from '../utils/e2e-sink';
import { requireSecret } from '../utils/secrets';
import { signInFallbackUrl } from '../utils/sign-in-restart';
import SendEmail from '../email';
import { inviteEmailHtml, inviteEmailSubject, inviteEmailText } from './email';
import { pageLocale, renderInvitePage, renderStaleInvitePage } from './page';
import { InviteError, InviteService, statusOf, type Invite, type InviteActor } from './service';
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
		const data = { email: invite.email, name: invite.name, link, expiresAt: invite.expiresAt, note: invite.note, locale: invite.locale };
		const result = await SendEmail({
			apiKey,
			from: INVITE_FROM,
			to: invite.email,
			subject: inviteEmailSubject(invite.locale),
			html: inviteEmailHtml(data),
			text: inviteEmailText(data),
		});
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

/** GET/POST /invite/:token — the link in the invite email. */
export async function routeInvitePage(request: Request, env: Env, ctx: ExecutionContext, requestId: string, theme?: Theme): Promise<Response | null> {
	const url = new URL(request.url);
	const match = /^\/invite\/([^/]+)\/?$/.exec(url.pathname);
	if (!match) return null;
	if (request.method !== 'GET' && request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { Allow: 'GET, POST' });
	const lang = pageLocale(url);
	const fallback = signInFallbackUrl(env);
	if (!(await withinRateLimit(env.PASSWORD_IP_LIMITER, `invite:ip:${getClientIP(request)}`))) {
		return renderStaleInvitePage(lang, fallback, theme).then((r) => new Response(r.body, { status: 429, headers: r.headers }));
	}

	const service = new InviteService(env.AUTH_DB);
	const row = await service.byToken(match[1]);
	const now = Date.now();
	const usable = row && row.token_used_at === null && statusOf(row, now) === 'invited';
	const signInUrl = (row && safeContinueUrl(row.continue_url, env)) || fallback;
	if (!row || !usable) return renderStaleInvitePage(lang, signInUrl, theme);

	if (request.method === 'GET') return renderInvitePage(lang, row.email, `${url.pathname}${url.search}`, theme);

	// POST: spend the link (single use; a concurrent second click sees it spent)
	if (!(await service.useToken(row.id))) return renderStaleInvitePage(lang, signInUrl, theme);
	ctx.waitUntil(
		emitAuditEvent({
			timestamp: new Date().toISOString(),
			eventType: AuditEventType.USER_INVITE_OPENED,
			severity: AuditEventSeverity.INFO,
			userId: row.user_id,
			ipAddress: getClientIP(request),
			userAgent: request.headers.get('User-Agent'),
			requestId,
			success: true,
			errorMessage: null,
			metadata: { inviteId: row.id },
		})
	);
	return new Response(null, { status: 303, headers: { Location: signInUrl, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
}

