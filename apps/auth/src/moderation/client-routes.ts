/**
 * Moderation requests: the API for registered client apps (docs/MODERATION_REQUESTS.md).
 *
 *   POST /moderation/requests                 file a request (Idempotency-Key)
 *   GET  /moderation/requests/:id             one of this client's requests + history
 *   GET  /moderation/requests?subject_user_id  this client's requests (filters)
 *   POST /moderation/requests/:id/info        answer an auth admin's request for more info
 *
 * The caller authenticates as an OAuth client (RFC 6749 §2.3.1, HTTP Basic
 * client_id:client_secret, the same check /token uses: createClientAuthMiddleware)
 * and must hold the moderation:request scope. A client only ever sees its own requests.
 */
import { createClientAuthMiddleware, type OAuthClient } from '../middleware/clientAuth';
import { withinRateLimit, RATE_LIMIT_PERIOD_SECONDS, getClientIP } from '../rate-limit';
import { emitAuditEvent } from '../audit-emitter';
import { AuditEventSeverity, AuditEventType } from '../audit-events';
import { logger } from '../logger';
import {
	CreateRequestSchema,
	MAX_REQUESTS_PER_CLIENT_PER_HOUR,
	MODERATION_ACTIONS,
	MODERATION_CLIENT_SCOPE,
	MODERATION_STATUSES,
	ProvideInfoSchema,
	payloadHash,
	validate,
} from './model';
import { ModerationStore, clientView } from './store';

const JSON_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });
}

const tooMany = () =>
	json({ error: 'rate_limit_exceeded', error_description: `Too many requests. Try again in ${RATE_LIMIT_PERIOD_SECONDS} seconds.` }, 429, {
		'Retry-After': String(RATE_LIMIT_PERIOD_SECONDS),
	});

const clientAuth = createClientAuthMiddleware();

/** Authenticates the calling client; a client without a stored secret is refused like a wrong one. */
export async function authenticateModerationClient(
	request: Request,
	env: Env,
	ctx: ExecutionContext
): Promise<{ ok: true; client: OAuthClient } | { ok: false; response: Response }> {
	let result: Awaited<ReturnType<typeof clientAuth>>;
	try {
		result = await clientAuth(request, env, ctx);
	} catch (error) {
		// verifyClientSecret throws on a client that has no secret hash
		logger.warn('[moderation] client authentication failed', { error: error instanceof Error ? error.message : String(error) });
		return {
			ok: false,
			response: json({ error: 'invalid_client', error_description: 'Client authentication failed' }, 401, {
				'WWW-Authenticate': 'Basic realm="moderation"',
			}),
		};
	}
	if (result.authenticated === false) return { ok: false, response: result.response };
	const scopes = Array.isArray(result.client.scopes) ? result.client.scopes : [];
	if (!scopes.includes(MODERATION_CLIENT_SCOPE)) {
		return {
			ok: false,
			response: json({ error: 'insufficient_scope', error_description: `Client lacks the ${MODERATION_CLIENT_SCOPE} scope` }, 403),
		};
	}
	return { ok: true, client: result.client };
}

async function readJson(request: Request): Promise<unknown> {
	try {
		return await request.json();
	} catch {
		return undefined;
	}
}

/** Returns a response for /moderation/requests[/...] or null for other paths. */
export async function routeModerationClient(request: Request, env: Env, ctx: ExecutionContext, requestId: string): Promise<Response | null> {
	const url = new URL(request.url);
	const match = /^\/moderation\/requests(?:\/([^/]+))?(\/info)?\/?$/.exec(url.pathname);
	if (!match) return null;
	const [, id, info] = match;

	const route =
		!id && request.method === 'POST' ? 'create' : !id && request.method === 'GET' ? 'list' : id && !info && request.method === 'GET' ? 'get' : id && info && request.method === 'POST' ? 'info' : null;
	if (!route) return json({ error: 'method_not_allowed' }, 405, { Allow: id && !info ? 'GET' : 'GET, POST' });

	const auth = await authenticateModerationClient(request, env, ctx);
	if (auth.ok === false) return auth.response;
	const client = auth.client;

	const writes = route === 'create' || route === 'info';
	const limiter = writes ? env.ADMIN_SENSITIVE_LIMITER : env.ADMIN_LIMITER;
	if (!(await withinRateLimit(limiter, `moderation:${writes ? 'write' : 'read'}:client:${client.id}`))) return tooMany();

	const store = new ModerationStore(env.AUTH_DB);
	const audit = (eventType: AuditEventType, metadata: Record<string, unknown>) =>
		emitAuditEvent({
			timestamp: new Date().toISOString(),
			eventType,
			severity: AuditEventSeverity.INFO,
			userId: null,
			ipAddress: getClientIP(request),
			userAgent: request.headers.get('User-Agent'),
			requestId,
			metadata: { clientId: client.id, clientName: client.name, ...metadata },
			success: true,
			errorMessage: null,
		});

	if (route === 'create') {
		const parsed = validate(CreateRequestSchema, await readJson(request));
		if (!parsed.ok) return json(parsed, 400);
		const input = parsed.value;
		const key = request.headers.get('Idempotency-Key')?.trim() || input.idempotency_key;
		if (!key || key.length < 8 || key.length > 128) {
			return json({ error: 'invalid_request', issues: [{ path: 'Idempotency-Key', message: 'An Idempotency-Key header (8-128 chars) is required' }] }, 400);
		}
		const hash = await payloadHash(input);

		const existing = await store.findByIdempotencyKey(client.id, key);
		if (existing) return replay(existing, hash, store);

		if ((await store.countRecentByClient(client.id, Date.now() - 3600_000)) >= MAX_REQUESTS_PER_CLIENT_PER_HOUR) return tooMany();

		const subject = await env.AUTH_DB.prepare('SELECT id FROM users WHERE id = ?').bind(input.subject_user_id).first<{ id: string }>();
		if (!subject) return json({ error: 'subject_not_found', error_description: 'No auth user has this id' }, 404);

		const created = await store.create({ clientId: client.id, tenantId: client.tenant_id || 'default', input, idempotencyKey: key, payloadHash: hash });
		if (!created) {
			// Lost a race with the same key
			const raced = await store.findByIdempotencyKey(client.id, key);
			if (raced) return replay(raced, hash, store);
			return json({ error: 'server_error' }, 500);
		}
		ctx.waitUntil(
			audit(AuditEventType.MODERATION_REQUEST_CREATED, {
				requestId: created.id,
				targetUserId: created.subject_user_id,
				action: created.action,
				reasonCategory: created.reason_category,
				requestedBy: { id: created.requested_by_id, name: created.requested_by_name },
			})
		);
		return json({ request: clientView(created, await store.events(created.id)) }, 201, { Location: `/moderation/requests/${created.id}` });
	}

	if (route === 'list') {
		const status = url.searchParams.get('status') || undefined;
		const action = url.searchParams.get('action') || undefined;
		if (status && !(MODERATION_STATUSES as readonly string[]).includes(status)) return json({ error: 'invalid_request', issues: [{ path: 'status', message: 'unknown status' }] }, 400);
		if (action && !(MODERATION_ACTIONS as readonly string[]).includes(action)) return json({ error: 'invalid_request', issues: [{ path: 'action', message: 'unknown action' }] }, 400);
		const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 1), 100);
		const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10) || 0, 0);
		const { rows, total } = await store.list({
			clientId: client.id,
			status,
			action,
			subjectUserId: url.searchParams.get('subject_user_id') || undefined,
			limit,
			offset,
		});
		return json({ requests: rows.map((r) => clientView(r)), total, limit, offset });
	}

	const row = await store.get(id!);
	// Another client's request reads as missing
	if (!row || row.client_id !== client.id) return json({ error: 'not_found' }, 404);

	if (route === 'get') return json({ request: clientView(row, await store.events(row.id)) });

	// route === 'info'
	const parsed = validate(ProvideInfoSchema, await readJson(request));
	if (!parsed.ok) return json(parsed, 400);
	const updated = await store.transition(row.id, 'provide_info', 'pending', {});
	if (!updated) return json({ error: 'invalid_state', error_description: `Request is ${row.status}; more information was not requested`, status: row.status }, 409);
	await store.addEvent(row.id, 'info_provided', { type: 'client', id: client.id, name: parsed.value.requested_by.display_name }, parsed.value.note, {
		requested_by_id: parsed.value.requested_by.id,
		evidence: parsed.value.evidence,
	});
	if (parsed.value.evidence.length) {
		const merged = [...JSON.parse(updated.evidence || '[]'), ...parsed.value.evidence].slice(0, 40);
		await env.AUTH_DB.prepare('UPDATE moderation_requests SET evidence = ? WHERE id = ?').bind(JSON.stringify(merged), row.id).run();
	}
	ctx.waitUntil(audit(AuditEventType.MODERATION_REQUEST_INFO_PROVIDED, { requestId: row.id, targetUserId: row.subject_user_id }));
	const fresh = (await store.get(row.id))!;
	return json({ request: clientView(fresh, await store.events(row.id)) });
}

/** The same key again: the original request (200) when the body matches, else 409. */
async function replay(existing: Awaited<ReturnType<ModerationStore['get']>> & object, hash: string, store: ModerationStore): Promise<Response> {
	if (existing.payload_hash !== hash) {
		return json({ error: 'idempotency_conflict', error_description: 'This Idempotency-Key was used for a different request', request_id: existing.id }, 409);
	}
	return json({ request: clientView(existing, await store.events(existing.id)) }, 200, { 'Idempotent-Replay': 'true' });
}
