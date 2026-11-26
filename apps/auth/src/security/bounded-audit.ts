import { getAuditEmitter } from '../audit-emitter';
import { AuditEventSeverity, AuditEventType, createAuditEvent, createRateLimitExceededEvent, type AuditEvent } from '../audit-events';
import { logger } from '../logger';
import { getClientIP, RATE_LIMIT_PERIOD_SECONDS } from '../rate-limit';
import { trackEvent } from '../utils/analytics';
import { hashToken } from '../utils/crypto';

const WINDOW_MS = RATE_LIMIT_PERIOD_SECONDS * 1000;
const MAX_KEYS_PER_WINDOW = 4096;
let currentWindow = -1;
const seen = new Set<string>();

type AuditContext = {
	request: Request;
	env: Pick<Env, 'AUTH_ANALYTICS'>;
	ctx: Pick<ExecutionContext, 'waitUntil'>;
	requestId: string;
};

function emitOnce(ctx: AuditContext['ctx'], key: string, event: () => AuditEvent): void {
	const window = Math.floor(Date.now() / WINDOW_MS);
	if (window !== currentWindow) {
		currentWindow = window;
		seen.clear();
	}
	// Claim synchronously before any I/O. Drop new keys when full so rotating keys
	// cannot evict earlier ones and re-open their write budget in the same isolate.
	if (seen.has(key) || seen.size >= MAX_KEYS_PER_WINDOW) return;
	seen.add(key);

	const emitter = getAuditEmitter();
	ctx.waitUntil((async () => {
		const auditEvent = event();
		// The primary key enforces the same minute across isolates and queue retries.
		auditEvent.id = await hashToken(JSON.stringify(['bounded-auth-audit', key, window]));
		await emitter.emit(auditEvent);
		// The async hash may complete after the request's normal flush.
		await emitter.flush();
	})().catch(() => logger.error('Could not emit bounded auth audit event')));
}

export function recordTokenRejection(
	context: AuditContext,
	endpoint: string,
	bucketKey: string,
	status: number,
	rateLimited = false,
): void {
	const auditKey = `token:${bucketKey}`;
	if (rateLimited) {
		recordRateLimitDenial(context, endpoint, auditKey);
		return;
	}
	const { request, env, ctx, requestId } = context;
	const ipAddress = getClientIP(request);
	const userAgent = request.headers.get('User-Agent') ?? undefined;
	trackEvent(env, {
		event: 'token_rejected',
		ipAddress,
		userAgent,
		errorCode: String(status),
		success: false,
	});
	emitOnce(ctx, auditKey, () => createAuditEvent(AuditEventType.TOKEN_VERIFY_FAILED, {
		severity: AuditEventSeverity.WARNING,
		ipAddress,
		userAgent,
		requestId,
		success: false,
		metadata: { endpoint, status },
	}));
}

export function recordRateLimitDenial(
	{ request, env, ctx, requestId }: AuditContext,
	endpoint: string,
	auditKey: string,
	analyticsEmail?: string,
): void {
	const ipAddress = getClientIP(request);
	const userAgent = request.headers.get('User-Agent') ?? undefined;
	trackEvent(env, { event: 'rate_limit_hit', email: analyticsEmail, ipAddress, userAgent });
	emitOnce(ctx, auditKey, () => createRateLimitExceededEvent(
		endpoint, 0, RATE_LIMIT_PERIOD_SECONDS, RATE_LIMIT_PERIOD_SECONDS, { ipAddress, userAgent, requestId },
	));
}

export type PasswordSignInFailure =
	| 'invalid_credentials'
	| 'rate_limited'
	| 'locked_out'
	| 'account_suspended'
	| 'account_deleted'
	| 'account_system'
	| 'sign_in_error';

export function recordPasswordSignInFailure(
	{ request, env, ctx }: AuditContext,
	outcome: PasswordSignInFailure,
): void {
	const ipAddress = getClientIP(request);
	trackEvent(env, { event: 'login_failed', ipAddress, errorCode: outcome, success: false });
	// Group by IP and outcome. An attacker cannot buy a new write by changing the email.
	emitOnce(ctx, `password:${outcome}:${ipAddress}`, () => createAuditEvent(AuditEventType.LOGIN_FAILED, {
		severity: AuditEventSeverity.WARNING,
		ipAddress,
		success: false,
		errorMessage: outcome,
		metadata: { method: 'password', failureReason: outcome },
	}));
}
