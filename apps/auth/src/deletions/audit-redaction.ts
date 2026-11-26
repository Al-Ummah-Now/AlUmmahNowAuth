/**
 * Batched, indexed redaction of a user's audit_events rows on account erase
 * (AlUmmahNowAuth#515, AUN-D1-SCALING story D1-4).
 *
 * When a user account is permanently purged, their rows still in D1
 * audit_events are scrubbed in small batches via the user_id index:
 *   - user_id       -> `erased:<random 128-bit hex>`, one random id per erase,
 *                      never derived from userId and never stored permanently
 *                      with it, so rows of one erased account stay grouped but
 *                      cannot be linked back even if every secret is exposed.
 *   - ip_address    -> NULL
 *   - user_agent    -> NULL
 *   - error_message -> NULL (failed sign-in messages can quote user input)
 *   - request_id    -> NULL (prevents cross-system correlation with request logs)
 *   - metadata      -> JSON object retaining only the allow-listed non-personal
 *                      fields from apps/auth/src/audit-events.ts; every unknown
 *                      field is dropped by default.
 *
 * Scope note: this covers D1 row redaction (step 2 of D1-4 "Erase"). The
 * `audit_subject_keys` tombstone table and late-event handling in
 * audit-consumer/archive arrive with the R2 archive & crypto-shredding PR.
 *
 * No full-table scan is ever performed.
 */

export const ERASED_SUBJECT_PREFIX = 'erased:';

export const AUDIT_REDACTION_BATCH_SIZE = 500;
export const AUDIT_REDACTION_MAX_BATCHES = 50;

/**
 * Non-personal metadata fields kept in plaintext after account erase
 * (AUN-D1-SCALING D1-4, matching apps/auth/src/audit-events.ts).
 * `email`, `failureReason`, `initiatedBy`, and every unknown field are dropped.
 */
export const AUDIT_METADATA_ALLOWLIST: ReadonlySet<string> = new Set([
	'method',
	'clientId',
	'tokenType',
	'grantType',
	'expiresIn',
	'scopes',
	'role',
	'changedFields',
]);

/** Allow-listed keys whose values are string arrays in audit-events.ts. */
const STRING_ARRAY_ALLOWLIST: ReadonlySet<string> = new Set(['scopes', 'changedFields']);

/**
 * Exact SQL statements executed by this module; exported so unit tests verify
 * EXPLAIN QUERY PLAN uses the user_id index and rowid PK without table scans.
 */
export const AUDIT_REDACTION_SQL = {
	selectBatch: `
		SELECT rowid AS row_id, metadata
		FROM audit_events
		WHERE user_id = ?1
		LIMIT ?2
	`,
	updateRow: `
		UPDATE audit_events
		SET user_id = ?1, ip_address = NULL, user_agent = NULL, error_message = NULL, request_id = NULL, metadata = ?2
		WHERE rowid = ?3 AND user_id = ?4
	`,
} as const;

export interface AuditRedactionOptions {
	batchSize?: number;
	maxBatches?: number;
	deadline?: number;
}

export interface AuditRedactionResult {
	redacted: number;
	batches: number;
	remaining: boolean;
}

/** Generates a random 128-bit `erased:<32-hex>` subject, never derived from userId. */
export function generateErasedSubject(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
	return `${ERASED_SUBJECT_PREFIX}${hex}`;
}

/**
 * Strips every metadata field except allow-listed non-personal fields from
 * `apps/auth/src/audit-events.ts`. `scopes` and `changedFields` allow arrays
 * of strings; all other allow-listed keys accept primitive values only.
 * Invalid JSON, null, arrays, and nested objects reduce to `{}`.
 */
export function redactAuditMetadata(raw: string | null | undefined): string {
	if (!raw) return '{}';
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return '{}';
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return '{}';
	}
	const out: Record<string, string | number | boolean | null | string[]> = {};
	for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (!AUDIT_METADATA_ALLOWLIST.has(key)) continue;
		if (STRING_ARRAY_ALLOWLIST.has(key) && Array.isArray(value)) {
			out[key] = value.filter((item): item is string => typeof item === 'string');
			continue;
		}
		if (value === null) {
			out[key] = null;
		} else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
			out[key] = value;
		}
	}
	return JSON.stringify(out);
}

/**
 * Redacts a user's audit_events rows in indexed batches of `batchSize` (default 500),
 * bounded by both `maxBatches` and the purge deadline.
 * Because each updated row's `user_id` changes from `userId` to `erased:<random>`,
 * subsequent batches seek the next unredacted rows via the `user_id` index without
 * OFFSET or table scans.
 */
export async function redactUserAuditEvents(
	db: D1Database,
	userId: string,
	erasedSubject: string,
	options: AuditRedactionOptions = {}
): Promise<AuditRedactionResult> {
	const batchSize = Math.max(1, Math.min(options.batchSize ?? AUDIT_REDACTION_BATCH_SIZE, 1000));
	const maxBatches = Math.max(1, options.maxBatches ?? AUDIT_REDACTION_MAX_BATCHES);
	const deadline = options.deadline ?? Infinity;

	let redacted = 0;
	let batches = 0;

	const selectStmt = db.prepare(AUDIT_REDACTION_SQL.selectBatch);
	const updateStmt = db.prepare(AUDIT_REDACTION_SQL.updateRow);

	while (batches < maxBatches && Date.now() < deadline) {
		let rows: Array<{ row_id: number; metadata: string | null }>;
		try {
			const res = await selectStmt
				.bind(userId, batchSize)
				.all<{ row_id: number; metadata: string | null }>();
			rows = res.results ?? [];
		} catch (error) {
			if (/no such table/i.test(error instanceof Error ? error.message : String(error))) {
				return { redacted: 0, batches: 0, remaining: false };
			}
			throw error;
		}

		if (rows.length === 0) {
			return { redacted, batches, remaining: false };
		}

		if (Date.now() >= deadline) break;

		const updates = rows.map((row) =>
			updateStmt.bind(erasedSubject, redactAuditMetadata(row.metadata), row.row_id, userId)
		);
		const results = await db.batch(updates);

		for (const result of results) redacted += result.meta.changes;
		batches++;

		if (rows.length < batchSize) {
			return { redacted, batches, remaining: false };
		}
	}

	if (Date.now() >= deadline) return { redacted, batches, remaining: true };

	// A full final batch may have cleared the last rows.
	const probe = await selectStmt.bind(userId, 1).first<{ row_id: number }>();
	return { redacted, batches, remaining: !!probe };
}
