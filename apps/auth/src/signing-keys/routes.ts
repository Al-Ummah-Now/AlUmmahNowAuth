/**
 * Admin > Signing keys (signing-keys/rotation.ts, #13):
 *
 *   GET  /admin/settings/signing-keys   the keys (no key material), their state, the policy and the job status
 *   POST /admin/settings/signing-keys   { action: "rotate" }   Super Admin: queue a rotation now
 *                                        { action: "retry" }    Super Admin: run the step again (after a flagged failure)
 *
 * Admins only (verifyAdminRequest checks the acting user's roles in D1).
 */
import { listSigningKeys } from '@al-ummah-now/openauth/keys';
import { getAuditEmitter } from '../audit-emitter';
import { AuditEventSeverity, AuditEventType, createAuditEvent } from '../audit-events';
import { verifyAdminRequest } from '../auth-middleware';
import { getClientIP, withinRateLimit } from '../rate-limit';
import { authStorage } from '../storage/auth-storage';
import { PUBLISH_LEAD_MS, ROTATE_EVERY_MS, enqueueRotation, readRotationStatus, retireAfterMs, scheduleOn } from './rotation';

export const SIGNING_KEYS_PATH = '/admin/settings/signing-keys';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

const isSuperAdmin = (roles: string[]) => roles.some((r) => ['super_admin', 'super admin'].includes(r.toLowerCase()));

export type SigningKeyState = 'pending' | 'active' | 'previous' | 'retired';

export async function handleSigningKeys(request: Request, env: Env, ctx: ExecutionContext, requestId: string): Promise<Response> {
	let actor: { id: string; roles: string[] };
	try {
		const auth = await verifyAdminRequest(request.clone(), env);
		if (auth.type === 'm2m') {
			if (!auth.actingUser) return json({ error: 'forbidden' }, 403);
			actor = { id: auth.actingUser.id, roles: auth.actingUser.roles };
		} else actor = { id: auth.user.id, roles: auth.user.roles };
	} catch {
		return json({ error: 'forbidden' }, 403);
	}

	if (request.method === 'GET') {
		const now = Date.now();
		const keys = await listSigningKeys(authStorage(env));
		const live = keys.filter((k) => !k.expired && !(k.activates && k.activates > now)).sort((a, b) => b.created - a.created);
		const activeId = live[0]?.id;
		const accessTtl = Number(env.ACCESS_TOKEN_TTL);
		const retireAfter = retireAfterMs(Number.isFinite(accessTtl) && accessTtl > 0 ? accessTtl : undefined);
		return json({
			keys: keys.map((k) => {
				const state: SigningKeyState = k.expired ? 'retired' : k.activates && k.activates > now ? 'pending' : k.id === activeId ? 'active' : 'previous';
				return { ...k, state };
			}),
			policy: { publishLeadMs: PUBLISH_LEAD_MS, rotateEveryMs: ROTATE_EVERY_MS, retireAfterMs: retireAfter, scheduled: scheduleOn(env) },
			status: await readRotationStatus(env.AUTH_DB),
			canRotate: isSuperAdmin(actor.roles),
		});
	}

	if (request.method === 'POST') {
		if (!isSuperAdmin(actor.roles)) return json({ error: 'super_admin_only' }, 403);
		let body: { action?: unknown } = {};
		try {
			body = (await request.json()) as { action?: unknown };
		} catch {
			// handled below
		}
		const action = body?.action;
		if (action !== 'rotate' && action !== 'retry') return json({ error: 'invalid_request' }, 400);
		if (!(await withinRateLimit(env.ADMIN_SENSITIVE_LIMITER, `signing-keys:rotate:${actor.id}`))) return json({ error: 'rate_limited' }, 429);
		const queued = await enqueueRotation(env, 'admin', actor.id, { force: action === 'rotate' });
		ctx.waitUntil(
			getAuditEmitter()
				.emit(
					createAuditEvent(AuditEventType.SIGNING_KEY_ROTATION_REQUESTED, {
						severity: AuditEventSeverity.CRITICAL,
						userId: actor.id,
						ipAddress: getClientIP(request),
						userAgent: request.headers.get('User-Agent'),
						requestId,
						metadata: { queued, action },
					})
				)
				.catch(() => undefined)
		);
		if (!queued) return json({ error: 'queue_unavailable' }, 503);
		return json({ queued: true }, 202);
	}

	return json({ error: 'method_not_allowed' }, 405);
}
