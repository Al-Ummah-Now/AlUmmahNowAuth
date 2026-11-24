/**
 * Tests for AlUmmahNowAuth#515 (AUN-D1-SCALING D1-4):
 * - Account purge redacts the user's audit_events rows in indexed batches:
 *   user_id -> random 128-bit `erased:<32-hex>` (one per erase, never derived
 *   from userId and never stored permanently with it),
 *   ip_address / user_agent / error_message / request_id -> NULL,
 *   metadata -> allow-listed fields from audit-events.ts only.
 * - Real event builders (createLoginSuccessEvent, createLoginFailedEvent,
 *   createTokenIssuedEvent, createAccountUpdatedEvent) preserve only allow-listed
 *   keys and scrub email, failureReason, initiatedBy, error_message, request_id.
 * - Other users' audit_events rows are untouched.
 * - Purge-level deferred resume: hitting the batch cap returns 'deferred'
 *   without failing or bumping attempts, keeps users/admin_deletions intact,
 *   reuses the same `erased:<hex>` on the next run, and deletes admin_deletions
 *   (destroying the temporary mapping) once complete.
 * - EXPLAIN QUERY PLAN verifies selectBatch uses the user_id index and
 *   updateRow uses the rowid PK, with no table scans.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { setupDatabase } from '../test-setup';
import {
	AUDIT_METADATA_ALLOWLIST,
	AUDIT_REDACTION_SQL,
	ERASED_SUBJECT_PREFIX,
	generateErasedSubject,
	redactAuditMetadata,
	redactUserAuditEvents,
} from '../deletions/audit-redaction';
import {
	createAccountUpdatedEvent,
	createLoginFailedEvent,
	createLoginSuccessEvent,
	createTokenIssuedEvent,
	type AuditEvent,
} from '../audit-events';
import { softDelete } from '../deletions/service';
import { purgeDeleted } from '../deletions/purge';
import { RETENTION_MS } from '../deletions/store';

vi.mock('../audit-emitter', () => ({ emitAuditEvent: vi.fn().mockResolvedValue(undefined) }));

const ENV = env as unknown as Env;
const db = () => ENV.AUTH_DB;
const ADMIN = { userId: 'redact-admin', email: 'admin@example.com' };

async function addUser(id: string, email: string) {
	const now = Date.now();
	await db()
		.prepare(
			`INSERT INTO users (id, tenant_id, email, status, created_at, updated_at, password_reset_required)
			 VALUES (?, 'default', ?, 'active', ?, ?, 0)`
		)
		.bind(id, email, now, now)
		.run();
}

async function addAuditEvent(event: AuditEvent) {
	await db()
		.prepare(
			`INSERT INTO audit_events (timestamp, event_type, severity, user_id, ip_address, user_agent, request_id, metadata, success, error_message)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.bind(
			event.timestamp,
			event.eventType,
			event.severity,
			event.userId,
			event.ipAddress,
			event.userAgent,
			event.requestId,
			JSON.stringify(event.metadata),
			event.success ? 1 : 0,
			event.errorMessage ?? null
		)
		.run();
}

describe('Audit event redaction on account erase (#515)', () => {
	beforeEach(async () => {
		await setupDatabase();
		await db().prepare('DELETE FROM audit_events').run();
		await db().prepare(`DELETE FROM users WHERE id LIKE 'redact-%'`).run();
		await db().prepare('DELETE FROM user_revocations').run();
		await db().prepare('DELETE FROM account_events').run();
	});

	describe('redactAuditMetadata', () => {
		it('keeps only D1-4 allow-listed fields (including string arrays for scopes/changedFields) and strips personal/unknown keys', () => {
			const input = JSON.stringify({
				email: 'secret@example.com',
				failureReason: 'Wrong password for secret@example.com',
				initiatedBy: 'admin-42',
				name: 'Full Name',
				custom_new_field: 'potential-pii',
				method: 'password',
				clientId: 'web-client',
				tokenType: 'refresh',
				grantType: 'authorization_code',
				expiresIn: 3600,
				scopes: ['openid', 'profile', 'email'],
				role: 'member',
				changedFields: ['name', 'avatar'],
			});

			const redacted = JSON.parse(redactAuditMetadata(input)) as Record<string, unknown>;
			expect(Object.keys(redacted).sort()).toEqual([...AUDIT_METADATA_ALLOWLIST].sort());
			expect(redacted).toEqual({
				method: 'password',
				clientId: 'web-client',
				tokenType: 'refresh',
				grantType: 'authorization_code',
				expiresIn: 3600,
				scopes: ['openid', 'profile', 'email'],
				role: 'member',
				changedFields: ['name', 'avatar'],
			});
		});

		it('drops nested objects and non-string items in allow-listed arrays, and handles invalid JSON', () => {
			expect(
				redactAuditMetadata(
					JSON.stringify({
						clientId: { nested: 'pii@example.com' },
						scopes: ['openid', { leak: 'x' }, 123, 'email'],
						method: 'oauth',
					})
				)
			).toBe(JSON.stringify({ scopes: ['openid', 'email'], method: 'oauth' }));
			expect(redactAuditMetadata('not-json')).toBe('{}');
			expect(redactAuditMetadata(null)).toBe('{}');
			expect(redactAuditMetadata('["array"]')).toBe('{}');
		});
	});

	describe('generateErasedSubject', () => {
		it('generates a fresh random 128-bit erased:<32-hex> id each call', () => {
			const a = generateErasedSubject();
			const b = generateErasedSubject();
			expect(a).toMatch(new RegExp(`^${ERASED_SUBJECT_PREFIX}[0-9a-f]{32}$`));
			expect(b).toMatch(new RegExp(`^${ERASED_SUBJECT_PREFIX}[0-9a-f]{32}$`));
			expect(a).not.toBe(b);
		});
	});

	describe('redactUserAuditEvents (batched & bounded)', () => {
		it('redacts real audit-events.ts event shapes across multiple batches without touching other users', async () => {
			await addAuditEvent(
				createLoginSuccessEvent('person@example.com', 'redact-u-batch', {
					ipAddress: '203.0.113.1',
					userAgent: 'Browser/1.0',
					requestId: 'req-login-1',
					clientId: 'web-app',
					method: 'password',
				})
			);
			const failedLogin = createLoginFailedEvent('person@example.com', 'Invalid password for person@example.com', {
				ipAddress: '203.0.113.2',
				userAgent: 'Browser/2.0',
				requestId: 'req-fail-2',
			});
			failedLogin.userId = 'redact-u-batch';
			await addAuditEvent(failedLogin);
			await addAuditEvent(
				createTokenIssuedEvent('redact-u-batch', 'web-app', {
					tokenType: 'refresh',
					grantType: 'authorization_code',
					expiresIn: 2592000,
					ipAddress: '203.0.113.3',
					userAgent: 'Browser/3.0',
					requestId: 'req-tok-3',
				})
			);
			await addAuditEvent(
				createAccountUpdatedEvent('redact-u-batch', 'person@example.com', ['name', 'email'], {
					initiatedBy: 'admin-99',
					ipAddress: '203.0.113.4',
					userAgent: 'Browser/4.0',
					requestId: 'req-upd-4',
				})
			);
			await addAuditEvent(
				createLoginSuccessEvent('other@example.com', 'redact-u-other', {
					ipAddress: '198.51.100.9',
					userAgent: 'OtherBrowser/1.0',
					requestId: 'req-other-1',
					clientId: 'ios-app',
					method: 'email_code',
				})
			);

			// First pass capped at 1 batch of 2 rows -> 2 redacted, remaining=true
			const pass1 = await redactUserAuditEvents(db(), 'redact-u-batch', { batchSize: 2, maxBatches: 1 });
			expect(pass1.redacted).toBe(2);
			expect(pass1.batches).toBe(1);
			expect(pass1.remaining).toBe(true);
			expect(pass1.erasedSubject).toMatch(new RegExp(`^${ERASED_SUBJECT_PREFIX}[0-9a-f]{32}$`));

			// Second pass resumes with the same erasedSubject and finishes the remaining 2 rows
			const pass2 = await redactUserAuditEvents(db(), 'redact-u-batch', {
				erasedSubject: pass1.erasedSubject!,
				batchSize: 2,
				maxBatches: 2,
			});
			expect(pass2).toEqual({
				redacted: 2,
				batches: 1,
				remaining: false,
				erasedSubject: pass1.erasedSubject,
			});

			// Zero rows remain under the original user_id
			const leftover = await db()
				.prepare('SELECT COUNT(*) AS c FROM audit_events WHERE user_id = ?')
				.bind('redact-u-batch')
				.first<{ c: number }>();
			expect(leftover?.c).toBe(0);

			// All 4 rows share the same erased:<hex> subject with all personal columns NULLed
			const redactedRows = await db()
				.prepare(
					'SELECT event_type, user_id, ip_address, user_agent, error_message, request_id, metadata FROM audit_events WHERE user_id = ? ORDER BY rowid ASC'
				)
				.bind(pass1.erasedSubject!)
				.all<{
					event_type: string;
					user_id: string;
					ip_address: string | null;
					user_agent: string | null;
					error_message: string | null;
					request_id: string | null;
					metadata: string;
				}>();

			expect(redactedRows.results).toHaveLength(4);
			for (const r of redactedRows.results) {
				expect(r.user_id).toBe(pass1.erasedSubject);
				expect(r.ip_address).toBeNull();
				expect(r.user_agent).toBeNull();
				expect(r.error_message).toBeNull();
				expect(r.request_id).toBeNull();
				expect(r.metadata).not.toContain('person@example.com');
				expect(r.metadata).not.toContain('admin-99');
				expect(r.metadata).not.toContain('failureReason');
			}
			expect(JSON.parse(redactedRows.results[0]!.metadata)).toEqual({ method: 'password', clientId: 'web-app' });
			expect(JSON.parse(redactedRows.results[1]!.metadata)).toEqual({ method: 'email_code' });
			expect(JSON.parse(redactedRows.results[2]!.metadata)).toEqual({
				tokenType: 'refresh',
				clientId: 'web-app',
				grantType: 'authorization_code',
				expiresIn: 2592000,
			});
			expect(JSON.parse(redactedRows.results[3]!.metadata)).toEqual({ changedFields: ['name', 'email'] });

			// Other user's audit row is completely untouched
			const other = await db()
				.prepare('SELECT user_id, ip_address, user_agent, request_id, metadata FROM audit_events WHERE user_id = ?')
				.bind('redact-u-other')
				.first<{ user_id: string; ip_address: string | null; user_agent: string | null; request_id: string | null; metadata: string }>();
			expect(other).toEqual({
				user_id: 'redact-u-other',
				ip_address: '198.51.100.9',
				user_agent: 'OtherBrowser/1.0',
				request_id: 'req-other-1',
				metadata: JSON.stringify({ email: 'other@example.com', method: 'email_code', clientId: 'ios-app' }),
			});
		});
	});

	describe('Account purge integration & deferred resume', () => {
		it('defers cleanly when batch cap is hit without failing or deleting user, then finishes with the same erased id on the next run', async () => {
			await addUser('redact-u-purge', 'purge-me@example.com');
			await addUser('redact-u-keep', 'keep-me@example.com');

			for (let i = 0; i < 5; i++) {
				const ev = createLoginFailedEvent('purge-me@example.com', `Bad code for purge-me@example.com #${i}`, {
					ipAddress: `203.0.113.${i + 1}`,
					userAgent: `PurgedUA/${i}`,
					requestId: `req-purge-${i}`,
				});
				ev.userId = 'redact-u-purge';
				await addAuditEvent(ev);
			}
			await addAuditEvent(
				createLoginSuccessEvent('keep-me@example.com', 'redact-u-keep', {
					ipAddress: '198.51.100.77',
					userAgent: 'KeptUA/1.0',
					requestId: 'req-keep-1',
					clientId: 'ios',
					method: 'password',
				})
			);

			const t0 = Date.now();
			await softDelete(ENV, 'user', 'redact-u-purge', ADMIN, { now: t0 });

			// Run 1: cap at 2 rows * 1 batch -> defers without error, attempts stays 0, user & admin_deletions remain
			const run1 = await purgeDeleted(ENV, {
				now: t0 + RETENTION_MS + 1,
				auditRedaction: { batchSize: 2, maxBatches: 1 },
			});
			expect(run1.purged.user).toBe(0);
			expect(run1.failed.user).toBe(0);

			const pendingDel = await db()
				.prepare(`SELECT attempts, last_error, snapshot FROM admin_deletions WHERE kind = 'user' AND item_id = ?`)
				.bind('redact-u-purge')
				.first<{ attempts: number; last_error: string | null; snapshot: string }>();
			expect(pendingDel?.attempts).toBe(0);
			expect(pendingDel?.last_error).toBeNull();
			const tempErasedId = (JSON.parse(pendingDel!.snapshot) as { erased_audit_id?: string }).erased_audit_id;
			expect(tempErasedId).toMatch(new RegExp(`^${ERASED_SUBJECT_PREFIX}[0-9a-f]{32}$`));

			// User row is still present and account-purged event has NOT been recorded yet
			expect(await db().prepare('SELECT id FROM users WHERE id = ?').bind('redact-u-purge').first()).not.toBeNull();
			expect(
				await db().prepare(`SELECT 1 FROM account_events WHERE user_id = ? AND type = 'account-purged'`).bind('redact-u-purge').first()
			).toBeNull();

			// Run 2: finishes remaining 3 rows with the exact same erased id, deletes user + admin_deletions
			const run2 = await purgeDeleted(ENV, {
				now: t0 + RETENTION_MS + 2,
				auditRedaction: { batchSize: 2, maxBatches: 5 },
			});
			expect(run2.purged.user).toBe(1);
			expect(run2.failed.user).toBe(0);

			// User and admin_deletions row (along with temporary erased_audit_id) are gone
			expect(await db().prepare('SELECT id FROM users WHERE id = ?').bind('redact-u-purge').first()).toBeNull();
			expect(
				await db().prepare(`SELECT 1 FROM admin_deletions WHERE kind = 'user' AND item_id = ?`).bind('redact-u-purge').first()
			).toBeNull();

			// All 5 audit rows share the single erased:<hex> subject with all personal columns cleared
			const remainingOriginal = await db()
				.prepare('SELECT COUNT(*) AS c FROM audit_events WHERE user_id = ?')
				.bind('redact-u-purge')
				.first<{ c: number }>();
			expect(remainingOriginal?.c).toBe(0);

			const redacted = await db()
				.prepare('SELECT user_id, ip_address, user_agent, error_message, request_id, metadata FROM audit_events WHERE user_id = ?')
				.bind(tempErasedId!)
				.all<{
					user_id: string;
					ip_address: string | null;
					user_agent: string | null;
					error_message: string | null;
					request_id: string | null;
					metadata: string;
				}>();
			expect(redacted.results).toHaveLength(5);
			for (const r of redacted.results) {
				expect(r).toEqual({
					user_id: tempErasedId,
					ip_address: null,
					user_agent: null,
					error_message: null,
					request_id: null,
					metadata: JSON.stringify({ method: 'email_code' }),
				});
			}

			// Other user's audit row was not touched
			const kept = await db()
				.prepare('SELECT ip_address, user_agent, request_id, metadata FROM audit_events WHERE user_id = ?')
				.bind('redact-u-keep')
				.first<{ ip_address: string | null; user_agent: string | null; request_id: string | null; metadata: string }>();
			expect(kept?.ip_address).toBe('198.51.100.77');
			expect(kept?.user_agent).toBe('KeptUA/1.0');
			expect(kept?.request_id).toBe('req-keep-1');
			expect(JSON.parse(kept!.metadata)).toEqual({ email: 'keep-me@example.com', method: 'password', clientId: 'ios' });
		});
	});

	describe('EXPLAIN QUERY PLAN index verification', () => {
		it('selectBatch uses the user_id index and updateRow uses rowid PK with no table scans', async () => {
			const selectPlan = await db()
				.prepare(`EXPLAIN QUERY PLAN ${AUDIT_REDACTION_SQL.selectBatch}`)
				.bind('redact-u1', 500)
				.all<{ detail: string }>();
			const selectDetail = selectPlan.results.map((r) => r.detail).join(' | ');
			expect(selectDetail).toMatch(/SEARCH audit_events USING (?:COVERING )?INDEX idx_audit_events_user_/);
			expect(selectDetail).not.toMatch(/\bSCAN\b/);
			expect(selectDetail).not.toContain('TEMP B-TREE');

			const updatePlan = await db()
				.prepare(`EXPLAIN QUERY PLAN ${AUDIT_REDACTION_SQL.updateRow}`)
				.bind('erased:00000000000000000000000000000000', '{}', 1)
				.all<{ detail: string }>();
			const updateDetail = updatePlan.results.map((r) => r.detail).join(' | ');
			expect(updateDetail).toContain('SEARCH audit_events USING INTEGER PRIMARY KEY (rowid=?)');
			expect(updateDetail).not.toMatch(/\bSCAN\b/);
		});
	});
});
