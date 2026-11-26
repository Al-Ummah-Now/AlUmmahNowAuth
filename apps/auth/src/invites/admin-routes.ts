import { Hono } from 'hono';
import { emitAuditEvent } from '../audit-emitter';
import { AuditEventSeverity, AuditEventType } from '../audit-events';
import { requireAdmin } from '../middleware/admin-auth';
import { rateLimit } from '../middleware/rate-limit';
import { getClientIP } from '../rate-limit';
import { INVITE_ID_RE, InviteError, InviteService, type Invite, type InviteStatus } from './service';

const adminStatuses = {
	invited: 'pending',
	active: 'accepted',
	expired: 'expired',
	revoked: 'revoked',
} as const;

function summary(invite: Invite) {
	return {
		id: invite.id,
		email: invite.email,
		name: invite.name,
		clientId: invite.clientId,
		status: adminStatuses[invite.status],
		invitedByUserId: invite.invitedBy,
		invitedByEmail: invite.invitedByEmail,
		createdAt: invite.createdAt,
		expiresAt: invite.expiresAt,
	};
}

type Variables = {
	adminUser: { userId: string; email: string; roles: string[] } | null;
	tenantId: string;
	clientId: string;
};

export function inviteAdminRoutes(requestId: string) {
	const app = new Hono<{ Bindings: Env; Variables: Variables }>().basePath('/admin/invites');
	app.use('*', requireAdmin());

	app.get('/', rateLimit({ keyPrefix: 'admin:invites:view' }), async (c) => {
		const { status, search, cursor, limit } = c.req.query();
		const serviceStatus = (Object.keys(adminStatuses) as InviteStatus[]).find((key) => adminStatuses[key] === status);
		if (status && status !== 'all' && !serviceStatus) return c.json({ error: 'invalid_status' }, 400);

		const tenantId = c.get('tenantId') || 'default';
		const db = c.env.AUTH_DB;
		const result = await new InviteService(db, { tenantId }).list({
			status: serviceStatus,
			q: search?.trim().slice(0, 100),
			cursor,
			limit: Number.parseInt(limit ?? '', 10) || 50,
		});
		const clientIds = [...new Set(result.invites.map((invite) => invite.clientId))];
		const names = new Map<string, string>();
		// Keep the bound variables within D1's per-statement limit.
		for (let i = 0; i < clientIds.length; i += 50) {
			const ids = clientIds.slice(i, i + 50);
			const { results } = await db.prepare(
				`SELECT id, name FROM oauth_clients WHERE tenant_id = ? AND id IN (${ids.map(() => '?').join(',')})`
			).bind(tenantId, ...ids).all<{ id: string; name: string }>();
			for (const { id, name } of results) names.set(id, name);
		}
		return c.json({
			invites: result.invites.map((invite) => ({ ...summary(invite), clientName: names.get(invite.clientId) ?? null })),
			nextCursor: result.nextCursor,
		});
	});

	app.post('/:id/revoke', rateLimit({ keyPrefix: 'admin:invites:revoke', sensitive: true }), async (c) => {
		const id = c.req.param('id');
		if (!INVITE_ID_RE.test(id)) return c.json({ error: 'invalid_invite_id' }, 400);
		const admin = c.get('adminUser')!;
		const clientId = c.get('clientId');
		const service = new InviteService(c.env.AUTH_DB, { tenantId: c.get('tenantId'), events: c.env });
		try {
			const invite = await service.revoke(id, { userId: admin.userId, email: admin.email, clientId });
			c.executionCtx.waitUntil(emitAuditEvent({
				timestamp: new Date().toISOString(),
				eventType: AuditEventType.USER_INVITE_REVOKED,
				severity: AuditEventSeverity.WARNING,
				userId: admin.userId,
				ipAddress: getClientIP(c.req.raw),
				userAgent: c.req.header('User-Agent') ?? null,
				requestId,
				success: true,
				errorMessage: null,
				metadata: { clientId, inviteId: invite.id, targetUserId: invite.userId, targetEmail: invite.email, actorEmail: admin.email },
			}));
			return c.json({ success: true });
		} catch (error) {
			if (error instanceof InviteError) return c.json({ error: error.code, error_description: error.message }, error.status);
			throw error;
		}
	});

	return app;
}
