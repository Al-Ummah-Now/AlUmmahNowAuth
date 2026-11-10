/**
 * Moderation requests: the contract and state machine (docs/MODERATION_REQUESTS.md).
 *
 * A registered client app (the videos admin) asks auth to act on one of its
 * identities. Only auth admins decide and act. This module has no Workers
 * imports so it can be unit tested on its own.
 */
import * as v from 'valibot';

export const MODERATION_ACTIONS = [
	'suspend_account',
	'delete_account',
	'revoke_sessions',
	'require_password_reset',
	'other',
] as const;
export type ModerationAction = (typeof MODERATION_ACTIONS)[number];

export const REASON_CATEGORIES = [
	'spam',
	'harassment',
	'hate_speech',
	'violent_content',
	'sexual_content',
	'impersonation',
	'copyright',
	'fraud',
	'compromised_account',
	'other',
] as const;
export type ReasonCategory = (typeof REASON_CATEGORIES)[number];

/**
 * pending        filed by the client, waiting for an auth admin
 * info_requested an auth admin asked the client for more information
 * approved       an auth admin approved it; the action has not (yet) run:
 *                action "other", or the action failed (action_error) and can be retried
 * rejected       an auth admin rejected it (final)
 * actioned       the action ran (final)
 */
export const MODERATION_STATUSES = ['pending', 'info_requested', 'approved', 'rejected', 'actioned'] as const;
export type ModerationStatus = (typeof MODERATION_STATUSES)[number];

export type Decision = 'approve' | 'reject' | 'request_info' | 'provide_info' | 'execute' | 'mark_actioned';

/** Which statuses each decision may start from. */
const ALLOWED_FROM: Record<Decision, readonly ModerationStatus[]> = {
	approve: ['pending', 'info_requested'],
	reject: ['pending', 'info_requested', 'approved'],
	request_info: ['pending'],
	provide_info: ['info_requested'],
	execute: ['approved'],
	mark_actioned: ['approved'],
};

export function canTransition(from: ModerationStatus, decision: Decision): boolean {
	return ALLOWED_FROM[decision].includes(from);
}

/** The statuses a decision may start from (for conditional UPDATEs). */
export function allowedFrom(decision: Decision): readonly ModerationStatus[] {
	return ALLOWED_FROM[decision];
}

export function isFinal(status: ModerationStatus): boolean {
	return status === 'rejected' || status === 'actioned';
}

/** Actions auth runs itself on approval; "other" is handled by hand and marked actioned. */
export function isAutomatic(action: ModerationAction): boolean {
	return action !== 'other';
}

const USER_ID = v.pipe(v.string(), v.trim(), v.regex(/^[A-Za-z0-9_-]{1,128}$/, 'subject_user_id must be an auth user id'));

const EVIDENCE_URL = v.pipe(
	v.string(),
	v.trim(),
	v.maxLength(2048),
	v.check((value) => {
		try {
			const url = new URL(value);
			return url.protocol === 'https:' || (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1'));
		} catch {
			return false;
		}
	}, 'evidence url must be an https URL')
);

export const EvidenceSchema = v.object({
	url: EVIDENCE_URL,
	label: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(200))),
});

const REQUESTED_BY = v.object({
	id: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(128)),
	display_name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
});

export const CreateRequestSchema = v.object({
	subject_user_id: USER_ID,
	action: v.picklist(MODERATION_ACTIONS, `action must be one of ${MODERATION_ACTIONS.join(', ')}`),
	reason_category: v.picklist(REASON_CATEGORIES, `reason_category must be one of ${REASON_CATEGORIES.join(', ')}`),
	reason: v.pipe(v.string(), v.trim(), v.minLength(1, 'reason is required'), v.maxLength(4000)),
	evidence: v.optional(v.pipe(v.array(EvidenceSchema), v.maxLength(20, 'at most 20 evidence links')), []),
	requested_by: REQUESTED_BY,
	idempotency_key: v.optional(v.pipe(v.string(), v.trim(), v.minLength(8), v.maxLength(128))),
});
export type CreateRequestInput = v.InferOutput<typeof CreateRequestSchema>;

export const ProvideInfoSchema = v.object({
	note: v.pipe(v.string(), v.trim(), v.minLength(1, 'note is required'), v.maxLength(4000)),
	evidence: v.optional(v.pipe(v.array(EvidenceSchema), v.maxLength(20)), []),
	requested_by: REQUESTED_BY,
});
export type ProvideInfoInput = v.InferOutput<typeof ProvideInfoSchema>;

export const DecisionSchema = v.object({
	note: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(4000))),
});

/** reject and request_info must explain themselves to the client. */
export function decisionNeedsNote(decision: Decision): boolean {
	return decision === 'reject' || decision === 'request_info';
}

export interface ValidationFailure {
	ok: false;
	error: string;
	issues: { path: string; message: string }[];
}

export function validate<T extends v.GenericSchema>(schema: T, input: unknown): { ok: true; value: v.InferOutput<T> } | ValidationFailure {
	const result = v.safeParse(schema, input);
	if (result.success) return { ok: true, value: result.output };
	return {
		ok: false,
		error: 'invalid_request',
		issues: result.issues.map((issue) => ({
			path: issue.path?.map((p) => String(p.key)).join('.') ?? '',
			message: issue.message,
		})),
	};
}

/** Stable hash of what the client asked for: the same key with a different body is a conflict. */
export async function payloadHash(input: CreateRequestInput): Promise<string> {
	const canonical = JSON.stringify([
		input.subject_user_id,
		input.action,
		input.reason_category,
		input.reason,
		input.evidence.map((e) => [e.url, e.label ?? null]),
		input.requested_by.id,
	]);
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Clients holding this scope may file moderation requests. */
export const MODERATION_CLIENT_SCOPE = 'moderation:request';
/** Auth RBAC permission (granted to Admin and Super Admin) to review and decide. */
export const MODERATION_PERMISSION = 'moderation_requests:manage';
/** Per client: at most this many new requests per hour (on top of the per-minute limiter). */
export const MAX_REQUESTS_PER_CLIENT_PER_HOUR = 100;
