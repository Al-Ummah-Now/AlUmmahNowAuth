/**
 * POST /internal/token-revocations (AlUmmahNowAuth#363): a registered client app
 * ends one native install's sign-in, or every sign-in of a user at one client.
 * The videos admin-api calls it from "Sign out this device" (lost staff device).
 *
 *   { "user_id": "usr_…", "install_id": "ins_…" }   that install's refresh tokens
 *   { "user_id": "usr_…", "client_id": "<id>" }     the user's refresh tokens at that client
 *
 * The caller authenticates as an OAuth client (HTTP Basic, as /token) holding
 * the tokens:revoke scope. The revoked refresh tokens are refused at their next
 * use; access tokens expire within ACCESS_TOKEN_TTL. A later sign-in on that
 * install works. The user (and a named client) must be in the caller's tenant,
 * else 404. Audited; answers 204.
 */
import { TOKEN_REVOKE_SCOPE } from '../../../../packages/auth-contract/client-scopes';
import { authenticateScopedClient } from '../moderation/client-routes';
import { withinRateLimit, getClientIP, RATE_LIMIT_PERIOD_SECONDS } from '../rate-limit';
import { emitAuditEvent } from '../audit-emitter';
import { AuditEventSeverity, AuditEventType } from '../audit-events';
import { clientScopeKey, installScopeKey, revokeScope } from './revocation-list';

export const TOKEN_REVOCATION_PATH = '/internal/token-revocations';

const ID = /^[A-Za-z0-9._-]{1,128}$/;

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });
}

type Target = { userId: string; installId: string; clientId?: undefined } | { userId: string; clientId: string; installId?: undefined };

/** The request body, or an error message. */
export function parseRevocationTarget(body: unknown): Target | string {
	if (!body || typeof body !== 'object') return 'A JSON body is required';
	const { user_id: userId, install_id: installId, client_id: clientId } = body as Record<string, unknown>;
	if (typeof userId !== 'string' || !ID.test(userId)) return 'user_id is required';
	if ((installId === undefined) === (clientId === undefined)) return 'Send exactly one of install_id or client_id';
	if (installId !== undefined) return typeof installId === 'string' && ID.test(installId) ? { userId, installId } : 'install_id is invalid';
	return typeof clientId === 'string' && ID.test(clientId) ? { userId, clientId } : 'client_id is invalid';
}

/** The target user, and the target client when one is named, belong to the calling client's tenant. */
async function inCallerTenant(db: D1Database, tenantId: string, target: Target): Promise<boolean> {
	const user = await db.prepare('SELECT tenant_id FROM users WHERE id = ?').bind(target.userId).first<{ tenant_id: string }>();
	if (!user || user.tenant_id !== tenantId) return false;
	if (!target.clientId) return true;
	const named = await db.prepare('SELECT tenant_id FROM oauth_clients WHERE id = ?').bind(target.clientId).first<{ tenant_id: string }>();
	return named?.tenant_id === tenantId;
}

export async function routeTokenRevocations(request: Request, env: Env, ctx: ExecutionContext, requestId: string): Promise<Response | null> {
	const url = new URL(request.url);
	if (url.pathname !== TOKEN_REVOCATION_PATH) return null;
	if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { Allow: 'POST' });

	const auth = await authenticateScopedClient(request, env, ctx, TOKEN_REVOKE_SCOPE, 'token-revocations');
	if (auth.ok === false) return auth.response;
	const client = auth.client;
	if (!(await withinRateLimit(env.ADMIN_SENSITIVE_LIMITER, `token-revocations:client:${client.id}`))) {
		return json({ error: 'rate_limit_exceeded', error_description: `Try again in ${RATE_LIMIT_PERIOD_SECONDS} seconds.` }, 429, {
			'Retry-After': String(RATE_LIMIT_PERIOD_SECONDS),
		});
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		body = undefined;
	}
	const target = parseRevocationTarget(body);
	if (typeof target === 'string') return json({ error: 'invalid_request', error_description: target }, 400);

	// Only the caller's own tenant: the user (and the client named) must be in it (404 otherwise)
	if (!(await inCallerTenant(env.AUTH_DB, client.tenant_id, target))) {
		return json({ error: 'not_found', error_description: 'No such user or client in this tenant' }, 404);
	}

	const scopeKey = target.installId ? installScopeKey(target.userId, target.installId) : clientScopeKey(target.userId, target.clientId!);
	const before = await revokeScope({ db: env.AUTH_DB, kv: env.TOKEN_REVOCATIONS }, scopeKey, target.installId ? 'install_signed_out' : 'client_signed_out');

	await emitAuditEvent({
		timestamp: new Date().toISOString(),
		eventType: AuditEventType.USER_TOKENS_REVOKED,
		severity: AuditEventSeverity.WARNING,
		userId: null,
		ipAddress: getClientIP(request),
		userAgent: request.headers.get('User-Agent'),
		requestId,
		metadata: {
			action: target.installId ? 'client.revoke_install_tokens' : 'client.revoke_client_tokens',
			callerClientId: client.id,
			targetUserId: target.userId,
			...(target.installId ? { installId: target.installId } : { clientId: target.clientId }),
			revokedBefore: before,
		},
		success: true,
		errorMessage: null,
	});
	return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
}
