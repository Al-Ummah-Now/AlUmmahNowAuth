/**
 * Moderation requests: the auth admin API (docs/MODERATION_REQUESTS.md).
 *
 *   GET  /admin/moderation-requests                  queue (status, client_id, action, subject_user_id, needs_attention, from, to)
 *   GET  /admin/moderation-requests/:id              request, history, the user, prior requests for the user
 *   POST /admin/moderation-requests/:id/approve      approve and queue the action (note optional)
 *   POST /admin/moderation-requests/:id/reject       reject (note required)
 *   POST /admin/moderation-requests/:id/request-info ask the client for more (note required)
 *   POST /admin/moderation-requests/:id/execute      queue a failed action again
 *   POST /admin/moderation-requests/:id/mark-actioned an approved request was handled by hand
 *
 * Admin only (requireAdmin) and the moderation_requests:manage permission in
 * auth's RBAC (granted to Admin and Super Admin by migrations 0022). The action
 * runs from the moderation-actions queue with retries (moderation/queue.ts) and
 * the same account code as the Users and Sessions pages (moderation/actions.ts);
 * a failure that outlives the retries flags the request ("needs attention").
 */
import { Hono } from 'hono';
import { requireAdmin } from '../middleware/admin-auth';
import { rateLimit } from '../middleware/rate-limit';
import { resolveUserDisplayName } from '../../../../packages/ui/src/display-name.ts';
import { emitAuditEvent } from '../audit-emitter';
import { AuditEventSeverity, AuditEventType } from '../audit-events';
import {
	DecisionSchema,
	MODERATION_ACTIONS,
	MODERATION_PERMISSION,
	MODERATION_STATUSES,
	canTransition,
	decisionNeedsNote,
	isAutomatic,
	validate,
	type Decision,
} from './model';
import { ModerationStore, adminView, type ModerationRequestRow } from './store';
import { enqueueExecution } from './queue';

type AdminUser = { userId: string; email: string; roles: string[] };
type Vars = { adminUser: AdminUser | null; tenantId: string; browserSession: unknown; activeAccount: unknown; scopes: string[]; token: unknown; clientId: string };

/** Admin has the permission through one of their (unexpired) roles. */
export async function hasModerationPermission(db: D1Database, userId: string): Promise<boolean> {
	const row = await db
		.prepare(
			`SELECT 1 AS ok FROM rbac_user_roles ur
			 JOIN rbac_role_permissions rp ON rp.role_id = ur.role_id
			 JOIN rbac_permissions p ON p.id = rp.permission_id
			 WHERE ur.user_id = ? AND p.name = ?
			   AND (ur.expires_at IS NULL OR ur.expires_at > unixepoch() * 1000)
			 LIMIT 1`
		)
		.bind(userId, MODERATION_PERMISSION)
		.first<{ ok: number }>();
	return !!row;
}

export function moderationAdminRoutes() {
	const app = new Hono<{ Bindings: Env; Variables: Vars }>().basePath('/admin/moderation-requests');

	app.use('*', requireAdmin());
	app.use('*', async (c, next) => {
		const admin = c.get('adminUser');
		if (!admin || !(await hasModerationPermission(c.env.AUTH_DB, admin.userId))) {
			return c.json({ error: `Forbidden: ${MODERATION_PERMISSION} permission required` }, 403);
		}
		await next();
	});

	const view = rateLimit({ keyPrefix: 'admin:moderation:view' });
	const decide = rateLimit({ keyPrefix: 'admin:moderation:decide', sensitive: true });

	app.get('/', view, async (c) => {
		const q = c.req.query();
		if (q.status && !(MODERATION_STATUSES as readonly string[]).includes(q.status)) return c.json({ error: 'invalid status' }, 400);
		if (q.action && !(MODERATION_ACTIONS as readonly string[]).includes(q.action)) return c.json({ error: 'invalid action' }, 400);
		const toMs = (s?: string, endOfDay = false) => {
			if (!s) return undefined;
			const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z` : s);
			return Number.isFinite(t) ? t : undefined;
		};
		const limit = Math.min(Math.max(parseInt(q.limit || '50', 10) || 50, 1), 100);
		const offset = Math.max(parseInt(q.offset || '0', 10) || 0, 0);
		const store = new ModerationStore(c.env.AUTH_DB);
		const { rows, total } = await store.list({
			status: q.status,
			action: q.action,
			clientId: q.client_id,
			subjectUserId: q.subject_user_id,
			needsAttention: q.needs_attention === '1' || q.needs_attention === 'true',
			from: toMs(q.from),
			to: toMs(q.to, true),
			limit,
			offset,
		});
		const [clients, users, open, needsAttention] = await Promise.all([
			clientNames(c.env.AUTH_DB, rows),
			userSummaries(c.env.AUTH_DB, rows.map((r) => r.subject_user_id)),
			store.openCount(),
			store.needsAttentionCount(),
		]);
		return c.json({
			requests: rows.map((r) => ({ ...adminView(r), client_name: clients.get(r.client_id) ?? null, subject: users.get(r.subject_user_id) ?? null })),
			total,
			open,
			needs_attention: needsAttention,
			limit,
			offset,
			clients: await allModerationClients(c.env.AUTH_DB),
		});
	});

	app.get('/:id', view, async (c) => {
		const store = new ModerationStore(c.env.AUTH_DB);
		const row = await store.get(c.req.param('id'));
		if (!row) return c.json({ error: 'not_found' }, 404);
		const [events, users, clients, prior] = await Promise.all([
			store.events(row.id),
			userSummaries(c.env.AUTH_DB, [row.subject_user_id]),
			clientNames(c.env.AUTH_DB, [row]),
			store.list({ subjectUserId: row.subject_user_id, limit: 50, offset: 0 }),
		]);
		return c.json({
			request: { ...adminView(row, events), client_name: clients.get(row.client_id) ?? null },
			subject: users.get(row.subject_user_id) ?? null,
			prior_requests: prior.rows.filter((r) => r.id !== row.id).map((r) => ({ ...adminView(r), client_name: null })),
		});
	});

	const decisionRoute = (path: string, decision: Decision) =>
		app.post(`/:id/${path}`, decide, async (c) => {
			const admin = c.get('adminUser')!;
			let body: unknown = {};
			try {
				body = await c.req.json();
			} catch {
				body = {};
			}
			const parsed = validate(DecisionSchema, body ?? {});
			if (!parsed.ok) return c.json(parsed, 400);
			const note = parsed.value.note?.length ? parsed.value.note : null;
			if (decisionNeedsNote(decision) && !note) return c.json({ error: 'invalid_request', issues: [{ path: 'note', message: 'A note for the requesting app is required' }] }, 400);

			const store = new ModerationStore(c.env.AUTH_DB);
			const row = await store.get(c.req.param('id'));
			if (!row) return c.json({ error: 'not_found' }, 404);
			if (!canTransition(row.status, decision)) return conflict(c, row);
			if (decision === 'mark_actioned' && isAutomatic(row.action) && row.execution_status !== 'failed') {
				// Automatic actions are marked by running them; only a failed one may be closed by hand
				return c.json({ error: 'invalid_state', error_description: 'The action runs from the queue; only a failed one can be closed by hand' }, 409);
			}
			if (decision === 'execute' && (!isAutomatic(row.action) || (row.execution_status !== 'failed' && row.execution_status !== null))) {
				return c.json({ error: 'invalid_state', error_description: `The action is ${row.execution_status ?? 'not automatic'}; only a failed one can be run again` }, 409);
			}

			const actor = { type: 'admin' as const, id: admin.userId, name: admin.email };
			const audit = (eventType: AuditEventType, success: boolean, metadata: Record<string, unknown>, severity = AuditEventSeverity.WARNING) =>
				emitAuditEvent({
					timestamp: new Date().toISOString(),
					eventType,
					severity,
					userId: admin.userId,
					ipAddress: c.req.header('CF-Connecting-IP') || null,
					userAgent: c.req.header('User-Agent') || null,
					requestId: null,
					metadata: { requestId: row.id, targetUserId: row.subject_user_id, action: row.action, clientId: row.client_id, note, ...metadata },
					success,
					errorMessage: success ? null : String(metadata.error ?? 'failed'),
				});

			if (decision === 'reject') {
				const updated = await store.transition(row.id, 'reject', 'rejected', { decision_note: note, decided_by: admin.userId, decided: true });
				if (!updated) return conflict(c, (await store.get(row.id))!);
				await store.addEvent(row.id, 'rejected', actor, note);
				await audit(AuditEventType.MODERATION_REQUEST_REJECTED, true, {}, AuditEventSeverity.INFO);
				return respond(c, store, updated.id);
			}

			if (decision === 'request_info') {
				const updated = await store.transition(row.id, 'request_info', 'info_requested', { decision_note: note, decided_by: admin.userId });
				if (!updated) return conflict(c, (await store.get(row.id))!);
				await store.addEvent(row.id, 'info_requested', actor, note);
				await audit(AuditEventType.MODERATION_REQUEST_INFO_REQUESTED, true, {}, AuditEventSeverity.INFO);
				return respond(c, store, updated.id);
			}

			if (decision === 'mark_actioned') {
				const updated = await store.transition(row.id, 'mark_actioned', 'actioned', {
					decision_note: note ?? row.decision_note,
					decided_by: admin.userId,
					actioned: true,
					action_result: { manual: true },
					action_error: null,
				});
				if (!updated) return conflict(c, (await store.get(row.id))!);
				if (updated.execution_status) await store.setExecution(row.id, 'done');
				await store.addEvent(row.id, 'actioned', actor, note, { manual: true });
				await audit(AuditEventType.MODERATION_REQUEST_ACTIONED, true, { manual: true });
				return respond(c, store, updated.id);
			}

			// approve, execute: queue the action (moderation/queue.ts)
			let current: ModerationRequestRow = row;
			if (decision === 'approve') {
				const approved = await store.transition(row.id, 'approve', 'approved', { decision_note: note, decided_by: admin.userId, decided: true, action_error: null });
				if (!approved) return conflict(c, (await store.get(row.id))!);
				current = approved;
				await store.addEvent(row.id, 'approved', actor, note);
				await audit(AuditEventType.MODERATION_REQUEST_APPROVED, true, {});
			}
			if (!isAutomatic(current.action)) return respond(c, store, current.id);
			if (decision === 'execute') await store.addEvent(current.id, 'action_requeued', actor, note);
			const queued = await enqueueExecution(c.env, store, current, admin.userId);
			if (!queued) {
				const failed = (await store.get(current.id))!;
				return respond(c, store, current.id, 502, { error: 'action_failed', error_description: failed.action_error ?? 'Could not queue the action' });
			}
			return respond(c, store, current.id, 202);
		});

	decisionRoute('approve', 'approve');
	decisionRoute('reject', 'reject');
	decisionRoute('request-info', 'request_info');
	decisionRoute('execute', 'execute');
	decisionRoute('mark-actioned', 'mark_actioned');

	return app;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function conflict(c: any, row: ModerationRequestRow) {
	return c.json({ error: 'invalid_state', error_description: `Request is ${row.status}`, status: row.status }, 409);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function respond(c: any, store: ModerationStore, id: string, status = 200, extra: Record<string, unknown> = {}) {
	const row = (await store.get(id))!;
	return c.json({ ...extra, request: adminView(row, await store.events(id)) }, status);
}

async function userSummaries(db: D1Database, ids: string[]) {
	const unique = [...new Set(ids)];
	const map = new Map<string, { id: string; email: string; name: string | null; status: string; password_reset_required: boolean; created_at: number }>();
	if (!unique.length) return map;
	const { results } = await db
		.prepare(`SELECT id, email, name, metadata, status, password_reset_required, created_at FROM users WHERE id IN (${unique.map(() => '?').join(',')})`)
		.bind(...unique)
		.all<{ id: string; email: string; name: string | null; metadata: string | null; status: string; password_reset_required: number; created_at: number }>();
	// name: the platform's display-name rule (name, then first + last), null when none
	for (const { metadata, ...u } of results ?? [])
		map.set(u.id, { ...u, name: resolveUserDisplayName({ name: u.name, metadata }) || null, password_reset_required: !!u.password_reset_required });
	return map;
}

async function clientNames(db: D1Database, rows: ModerationRequestRow[]) {
	const ids = [...new Set(rows.map((r) => r.client_id))];
	const map = new Map<string, string>();
	if (!ids.length) return map;
	const { results } = await db
		.prepare(`SELECT id, name FROM oauth_clients WHERE id IN (${ids.map(() => '?').join(',')})`)
		.bind(...ids)
		.all<{ id: string; name: string }>();
	for (const r of results ?? []) map.set(r.id, r.name);
	return map;
}

/** Clients that may file requests (the queue's client filter). */
async function allModerationClients(db: D1Database) {
	const { results } = await db
		.prepare(`SELECT id, name FROM oauth_clients WHERE scopes LIKE '%"moderation:request"%' ORDER BY name`)
		.all<{ id: string; name: string }>();
	return results ?? [];
}
