/**
 * Signing-key rotation (AlUmmahNowAuth#13, docs/SIGNING_KEY_ROTATION.md).
 *
 *   1. publish  a new key is added pending: in JWKS at once, signing only from
 *               `activates` = now + PUBLISH_LEAD_MS, so every verifier's cache
 *               (edge JWKS cache, app caches) holds it before a token uses it;
 *   2. switch   from `activates` the new key signs; the previous key still
 *               verifies (overlap);
 *   3. retire   once the new key has signed for retireAfterMs (longer than any
 *               token the previous key signed lives), the previous key leaves
 *               JWKS and its private key is deleted.
 *
 * Every step runs as a `signing-keys.rotate` message on the moderation-actions
 * queue (the Auth worker's job queue, retried with backoff, DLQ). The hourly
 * cron queues one: it retires replaced keys and, where
 * SIGNING_KEY_ROTATION_SCHEDULE is "on", gives a key older than
 * ROTATE_EVERY_MS a successor. A Super Admin queues one from Admin > Signing
 * keys (rotate now). A step is
 * idempotent: it only does what the key index says is due. Every change is
 * audited; a step that keeps failing is flagged on the admin page, the audit
 * log (needsAttention) and the Errors page.
 */
import { addPendingSigningKey, listSigningKeys, retireSigningKey, type SigningKeyInfo } from '@al-ummah-now/openauth/keys';
import type { StorageAdapter } from '@al-ummah-now/openauth/storage/storage';
import { emitAuditEvent } from '../audit-emitter';
import { AuditEventSeverity, AuditEventType } from '../audit-events';
import { reportAuthError, type ErrorReportEnv } from '../errors/report';
import { logger } from '../logger';
import { getSetting, putSetting } from '../passkeys/store';
import { authStorage } from '../storage/auth-storage';
import { clearJWKSCache } from '../utils/jwks-cache';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * How long a new key is published before it signs. Covers the JWKS edge cache
 * (5 min), what verifiers may cache from Cache-Control (5 min), the issuer's
 * and verifiers' in-memory key caches (5-10 min), with a wide margin.
 */
export const PUBLISH_LEAD_MS = HOUR;
/** A key that has signed this long gets a successor. */
export const ROTATE_EVERY_MS = 90 * DAY;
/** openauth's default lifetime of an access token when ACCESS_TOKEN_TTL is not set (30 days). */
const DEFAULT_ACCESS_TTL_S = 30 * 24 * 60 * 60;
/** M2M (client_credentials) tokens live 1 hour (openauth default). */
const M2M_TTL_S = 60 * 60;

/**
 * How long the new key signs before the previous one is retired: twice the
 * longest lifetime of a token the issuer signs, and at least a day.
 */
export function retireAfterMs(accessTtlSeconds?: number): number {
	const longest = Math.max(accessTtlSeconds ?? DEFAULT_ACCESS_TTL_S, M2M_TTL_S);
	return Math.max(DAY, 2 * longest * 1000);
}

export type RotationTrigger = 'schedule' | 'admin';

export interface RotationMessage {
	type: 'signing-keys.rotate';
	trigger: RotationTrigger;
	/** The Super Admin who asked (trigger 'admin'). */
	adminId?: string;
	/** Add a pending key even if the current one is not due (rotate now). */
	force?: boolean;
	requestedAt: number;
}

export interface RotationPolicy {
	now: number;
	force: boolean;
	retireAfterMs: number;
	rotateEveryMs?: number;
	publishLeadMs?: number;
}

export interface RotationOutcome {
	added: SigningKeyInfo | null;
	retired: string[];
	active: string | null;
}

const isPending = (k: SigningKeyInfo, now: number) => !k.expired && !!k.activates && k.activates > now;
const isLive = (k: SigningKeyInfo, now: number) => !k.expired && !isPending(k, now);
const since = (k: SigningKeyInfo) => k.activates ?? k.created;

/** One idempotent rotation step over the issuer's key index. */
export async function rotationStep(storage: StorageAdapter, policy: RotationPolicy): Promise<RotationOutcome> {
	const { now } = policy;
	const keys = await listSigningKeys(storage);
	const live = keys.filter((k) => isLive(k, now)).sort((a, b) => b.created - a.created);
	const active = live[0] ?? null;
	const retired: string[] = [];
	// Retire the keys the active key replaced, once their tokens have all expired
	if (active && now - since(active) >= policy.retireAfterMs) {
		for (const old of live.slice(1)) {
			if (await retireSigningKey(storage, old.id, now)) retired.push(old.id);
		}
	}
	let added: SigningKeyInfo | null = null;
	const due = active && now - since(active) >= (policy.rotateEveryMs ?? ROTATE_EVERY_MS);
	if (!keys.some((k) => isPending(k, now)) && (policy.force || due)) {
		added = await addPendingSigningKey(storage, now + (policy.publishLeadMs ?? PUBLISH_LEAD_MS));
	}
	if (added || retired.length) clearJWKSCache();
	return { added, retired, active: active?.id ?? null };
}

// ---------- status shown on the admin page ----------

export const ROTATION_STATUS_SETTING = 'signing_key_rotation';

export interface RotationStatus {
	lastRunAt: number | null;
	lastTrigger: RotationTrigger | null;
	lastAdded: string | null;
	lastRetired: string[];
	/** Set while a rotate-now request waits in the queue. */
	queuedAt: number | null;
	queuedBy: string | null;
	/** The last failure that ran out of retries (cleared by the next good run). */
	error: string | null;
	errorAt: number | null;
	attempts: number;
}

const EMPTY_STATUS: RotationStatus = {
	lastRunAt: null,
	lastTrigger: null,
	lastAdded: null,
	lastRetired: [],
	queuedAt: null,
	queuedBy: null,
	error: null,
	errorAt: null,
	attempts: 0,
};

export async function readRotationStatus(db: D1Database): Promise<RotationStatus> {
	const raw = await getSetting<Partial<RotationStatus>>(db, ROTATION_STATUS_SETTING);
	return { ...EMPTY_STATUS, ...(raw ?? {}) };
}

async function writeRotationStatus(db: D1Database, patch: Partial<RotationStatus>, by: string | null): Promise<void> {
	const current = await readRotationStatus(db);
	await putSetting(db, ROTATION_STATUS_SETTING, { ...current, ...patch }, by);
}

// ---------- queue ----------

export const MAX_ATTEMPTS = 7; // first try + max_retries 6 (wrangler config)

export interface RotationEnv extends ErrorReportEnv {
	AUTH_DB: D1Database;
	AUTH_STORAGE: KVNamespace;
	MODERATION_QUEUE?: Queue;
	ACCESS_TOKEN_TTL?: string;
	/**
	 * "on": the hourly step also starts a rotation when the key in use is due.
	 * Otherwise it only finishes rotations (retires replaced keys); a rotation
	 * starts from Admin > Signing keys only.
	 */
	SIGNING_KEY_ROTATION_SCHEDULE?: string;
}

/** Scheduled rotation is switched on for this environment. */
export const scheduleOn = (env: { SIGNING_KEY_ROTATION_SCHEDULE?: string }) => env.SIGNING_KEY_ROTATION_SCHEDULE === 'on';

function audit(type: AuditEventType, severity: AuditEventSeverity, userId: string | null, metadata: Record<string, unknown>, error?: string) {
	return emitAuditEvent({
		timestamp: new Date().toISOString(),
		eventType: type,
		severity,
		userId,
		ipAddress: null,
		userAgent: null,
		requestId: null,
		metadata,
		success: !error,
		errorMessage: error ?? null,
	}).catch(() => undefined);
}

/**
 * Queue a rotation step (an admin's: rotate now, or `force: false` to retry a
 * failed step without starting a rotation). Returns false when the queue is missing or refused
 * the message (the failure is recorded and flagged; nothing is retried).
 */
export async function enqueueRotation(env: RotationEnv, trigger: RotationTrigger, adminId?: string, options: { force?: boolean } = {}): Promise<boolean> {
	// An admin's request rotates now unless it only retries a failed step
	const force = trigger === 'admin' && options.force !== false;
	const message: RotationMessage = { type: 'signing-keys.rotate', trigger, requestedAt: Date.now(), ...(trigger === 'admin' ? { adminId } : {}), ...(force ? { force: true } : {}) };
	if (!env.MODERATION_QUEUE) {
		await flagFailed(env, message, 'The job queue is not configured (MODERATION_QUEUE)', 0);
		return false;
	}
	try {
		await env.MODERATION_QUEUE.send(message, { contentType: 'json' });
	} catch (error) {
		await flagFailed(env, message, `Could not queue the rotation: ${error instanceof Error ? error.message : String(error)}`, 0);
		return false;
	}
	if (trigger === 'admin') await writeRotationStatus(env.AUTH_DB, { queuedAt: message.requestedAt, queuedBy: adminId ?? null }, adminId ?? null);
	return true;
}

async function flagFailed(env: RotationEnv, message: RotationMessage, error: string, attempts: number) {
	logger.error('[signing-keys] rotation failed', { trigger: message.trigger, attempts, error });
	// The Errors page (AlUmmahNowAuth#341)
	reportAuthError(env, undefined, new Error(error), { route: 'queue:signing-keys.rotate', extra: { trigger: message.trigger, attempts } });
	await writeRotationStatus(env.AUTH_DB, { error, errorAt: Date.now(), attempts, queuedAt: null, queuedBy: null }, message.adminId ?? null);
	await audit(
		AuditEventType.SIGNING_KEY_ROTATION_FAILED,
		AuditEventSeverity.ERROR,
		message.adminId ?? null,
		{ trigger: message.trigger, attempts, error, needsAttention: true },
		error
	);
}

export type RotationResult = 'done' | 'retry' | 'failed';

/** One delivery of a signing-keys.rotate message. */
export async function runRotation(env: RotationEnv, message: RotationMessage, attempt: number, storage: StorageAdapter = authStorage(env)): Promise<RotationResult> {
	const accessTtl = Number(env.ACCESS_TOKEN_TTL);
	try {
		const outcome = await rotationStep(storage, {
			now: Date.now(),
			force: message.force === true,
			// Schedule off: never start a rotation from the clock, only finish one
			rotateEveryMs: scheduleOn(env) ? ROTATE_EVERY_MS : Number.POSITIVE_INFINITY,
			retireAfterMs: retireAfterMs(Number.isFinite(accessTtl) && accessTtl > 0 ? accessTtl : undefined),
		});
		const by = message.adminId ?? null;
		if (outcome.added) {
			await audit(AuditEventType.SIGNING_KEY_ADDED, AuditEventSeverity.CRITICAL, by, {
				kid: outcome.added.id,
				activates: outcome.added.activates,
				replaces: outcome.active,
				trigger: message.trigger,
			});
		}
		for (const kid of outcome.retired) {
			await audit(AuditEventType.SIGNING_KEY_RETIRED, AuditEventSeverity.CRITICAL, by, { kid, active: outcome.active, trigger: message.trigger });
		}
		await writeRotationStatus(
			env.AUTH_DB,
			{
				lastRunAt: Date.now(),
				lastTrigger: message.trigger,
				...(outcome.added ? { lastAdded: outcome.added.id } : {}),
				...(outcome.retired.length ? { lastRetired: outcome.retired } : {}),
				...(message.trigger === 'admin' ? { queuedAt: null, queuedBy: null } : {}),
				error: null,
				errorAt: null,
				attempts: 0,
			},
			by
		);
		return 'done';
	} catch (error) {
		const text = `Signing-key rotation failed (attempt ${attempt}): ${error instanceof Error ? error.message : String(error)}`;
		logger.warn('[signing-keys] rotation step failed', { attempt, error: text });
		if (attempt >= MAX_ATTEMPTS) {
			await flagFailed(env, message, text, attempt);
			return 'failed';
		}
		return 'retry';
	}
}

/** The dead-letter queue: retries ran out without a recorded failure. */
export async function deadLetterRotation(env: RotationEnv, message: RotationMessage, attempts: number): Promise<void> {
	await flagFailed(env, message, 'The signing-key rotation failed after every retry', attempts);
}

export function isRotationMessage(body: unknown): body is RotationMessage {
	return !!body && typeof body === 'object' && (body as { type?: unknown }).type === 'signing-keys.rotate';
}

/** Backoff before retry n (1-based): 30 s doubling, at most 15 minutes (same as moderation actions). */
const retryDelaySeconds = (attempt: number) => Math.min(30 * 2 ** Math.max(attempt - 1, 0), 900);

/** The rotation messages of a job-queue batch (index.ts); other messages are left alone. */
export async function handleRotationMessages(batch: MessageBatch<unknown>, env: RotationEnv): Promise<void> {
	const dlq = batch.queue.endsWith('-dlq');
	for (const msg of batch.messages) {
		if (!isRotationMessage(msg.body)) continue;
		try {
			if (dlq) {
				await deadLetterRotation(env, msg.body, msg.attempts);
				msg.ack();
				continue;
			}
			const result = await runRotation(env, msg.body, msg.attempts);
			if (result === 'retry') msg.retry({ delaySeconds: retryDelaySeconds(msg.attempts) });
			else msg.ack();
		} catch (error) {
			logger.error('[signing-keys] queue handler error', { error: error instanceof Error ? error.message : String(error) });
			msg.retry({ delaySeconds: retryDelaySeconds(msg.attempts) });
		}
	}
}
