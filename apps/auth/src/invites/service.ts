/**
 * Admin invites (docs/USER_INVITES.md).
 *
 * An invite pre-provisions a real account: a `users` row with a stable id,
 * status `invited` and metadata.email_verified = false. From that moment the
 * account can be found in user search, linked and given roles, plans and
 * channels. When the person first signs in with that email by any method
 * (every method proves the address with an emailed code), the issuer's
 * onSuccess finds this row by email and claims it (claimInvitedAccount):
 * status becomes `active`, the email verified, the invite accepted. Same id, so
 * everything assigned beforehand is already theirs.
 *
 * An invited account gets no tokens by any other way in: the token gate,
 * refresh check and session sign-on all treat a non-active status as refused.
 *
 * The invite link carries a random single-use token; only its SHA-256 is
 * stored and it is never logged. The link is a convenience: an expired (or
 * already used) link still lets the person sign in with the email and claim
 * the account. Only revoking an invite stops the claim (the account is soft
 * deleted with it, so the email is free for a normal sign-up).
 *
 * Revoke is an admin soft delete (deleted_at/by/reason): restorable for 30
 * days, then purged with its never-used account by the hourly cleanup
 * (purgeRevokedInvites); "Delete permanently now" only queues it for the
 * cleanup's next run.
 */
import { generateSecureToken, hashToken } from '../utils/crypto';
import { emitAuditEvent } from '../audit-emitter';
import { AuditEventSeverity, AuditEventType } from '../audit-events';
import { DeletionStore } from '../deletions/store';

export const DEFAULT_INVITE_TTL_DAYS = 14;
export const MAX_INVITE_TTL_DAYS = 90;
export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Ids are minted by the inviting app (stable before Auth has the row). */
export const USER_ID_RE = /^usr_[0-9a-f]{32}$/;
export const INVITE_ID_RE = /^inv_[0-9a-f]{32}$/;
/**
 * Auth roles an inviting app may give on top of Member, by role name. Only
 * non-privileged roles: Admin, Super Admin and Moderator stay with Auth admins.
 */
export const INVITE_GRANTABLE_ROLES: Readonly<Record<string, string>> = { Scholar: 'role_scholar' };

export type InviteStatus = 'invited' | 'active' | 'expired' | 'revoked';
export type InviteLocale = 'en' | 'ar';

export class InviteError extends Error {
	constructor(
		public status: 400 | 403 | 404 | 409 | 410 | 429,
		public code: string,
		message: string,
		public extra?: Record<string, unknown>
	) {
		super(message);
	}
}

/** Who acted: the inviting app's admin (ids from that app) and the app's OAuth client. */
export interface InviteActor {
	userId: string;
	email: string;
	clientId: string;
}

interface InviteRow {
	id: string;
	tenant_id: string;
	user_id: string;
	email: string;
	name: string | null;
	locale: string;
	note: string | null;
	client_id: string;
	details: string;
	continue_url: string | null;
	token_hash: string | null;
	token_used_at: number | null;
	invited_by: string;
	invited_by_email: string | null;
	created_at: number;
	updated_at: number;
	expires_at: number;
	last_sent_at: number | null;
	send_count: number;
	accepted_at: number | null;
	deleted_at: number | null;
	deleted_by: string | null;
	deleted_by_email: string | null;
	deleted_reason: string | null;
	purge_requested_at: number | null;
	purge_requested_by: string | null;
}

export interface Invite {
	id: string;
	userId: string;
	email: string;
	name: string | null;
	locale: InviteLocale;
	note: string | null;
	clientId: string;
	details: Record<string, unknown>;
	status: InviteStatus;
	invitedBy: string;
	invitedByEmail: string | null;
	createdAt: number;
	updatedAt: number;
	expiresAt: number;
	lastSentAt: number | null;
	sendCount: number;
	linkUsedAt: number | null;
	acceptedAt: number | null;
	deletedAt: number | null;
	deletedBy: string | null;
	deletedByEmail: string | null;
	deletedReason: string | null;
	purgeRequestedAt: number | null;
	/** Revoked: when the cleanup removes it (30 days after revoke, or its next run once queued). */
	purgeAfter: number | null;
}

export interface InviteUser {
	id: string;
	email: string;
	name: string | null;
	status: string;
}

/** Same rule as D1UserService and sign-in: lower case, trimmed. Gmail dots and +tags are distinct addresses. */
export const normalizeInviteEmail = (email: string) => email.toLowerCase().trim();

/** One @, something before it, a dotted domain after it, no spaces; linear time (no backtracking regex). */
export function isEmailAddress(value: string): boolean {
	if (value.length > 254 || /\s/.test(value)) return false;
	const at = value.indexOf('@');
	if (at < 1 || at !== value.lastIndexOf('@')) return false;
	const domain = value.slice(at + 1);
	const dot = domain.lastIndexOf('.');
	return dot > 0 && dot < domain.length - 1;
}

export function statusOf(row: Pick<InviteRow, 'deleted_at' | 'accepted_at' | 'expires_at'>, now: number): InviteStatus {
	if (row.deleted_at !== null) return 'revoked';
	if (row.accepted_at !== null) return 'active';
	if (row.expires_at <= now) return 'expired';
	return 'invited';
}

function parseJson<T>(raw: string | null, fallback: T): T {
	if (!raw) return fallback;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return fallback;
	}
}

function toInvite(row: InviteRow, now: number): Invite {
	return {
		id: row.id,
		userId: row.user_id,
		email: row.email,
		name: row.name,
		locale: row.locale === 'ar' ? 'ar' : 'en',
		note: row.note,
		clientId: row.client_id,
		details: parseJson(row.details, {}),
		status: statusOf(row, now),
		invitedBy: row.invited_by,
		invitedByEmail: row.invited_by_email,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		expiresAt: row.expires_at,
		lastSentAt: row.last_sent_at,
		sendCount: row.send_count,
		linkUsedAt: row.token_used_at,
		acceptedAt: row.accepted_at,
		deletedAt: row.deleted_at,
		deletedBy: row.deleted_by,
		deletedByEmail: row.deleted_by_email,
		deletedReason: row.deleted_reason,
		purgeRequestedAt: row.purge_requested_at,
		purgeAfter: row.deleted_at === null ? null : row.purge_requested_at ?? row.deleted_at + RETENTION_MS,
	};
}

export interface CreateInviteInput {
	/** Minted by the inviting app (usr_ + 32 hex): the account's id from the start. */
	userId: string;
	/** Minted by the inviting app (inv_ + 32 hex): the idempotency key of the create. */
	inviteId: string;
	email: string;
	name?: string | null;
	locale?: string;
	note?: string | null;
	expiresInDays?: number;
	continueUrl?: string | null;
	details?: Record<string, unknown>;
	/** Extra Auth roles by name, from INVITE_GRANTABLE_ROLES (e.g. ["Scholar"]). */
	roles?: string[];
}

export interface ListInvitesParams {
	status?: InviteStatus;
	q?: string;
	userId?: string;
	cursor?: string;
	limit?: number;
}

/** A fresh link token: the raw value (for the link, returned once) and its stored hash. */
export async function newInviteToken(): Promise<{ token: string; hash: string }> {
	const token = await generateSecureToken(32);
	return { token, hash: await hashToken(token) };
}

function ttlDays(value: number | undefined, fallback: number): number {
	if (value === undefined || value === null) return fallback;
	if (!Number.isFinite(value) || value < 1 || value > MAX_INVITE_TTL_DAYS) {
		throw new InviteError(400, 'invalid_request', `expiresInDays must be between 1 and ${MAX_INVITE_TTL_DAYS}`);
	}
	return Math.floor(value);
}

function cleanText(value: unknown, max: number): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return trimmed ? trimmed.slice(0, max) : null;
}

export class InviteService {
	constructor(
		private readonly db: D1Database,
		private readonly options: { tenantId?: string; defaultTtlDays?: number; now?: () => number } = {}
	) {}

	private get tenantId() {
		return this.options.tenantId ?? 'default';
	}
	private now() {
		return (this.options.now ?? Date.now)();
	}
	private get defaultTtl() {
		const days = this.options.defaultTtlDays;
		return days && days >= 1 && days <= MAX_INVITE_TTL_DAYS ? Math.floor(days) : DEFAULT_INVITE_TTL_DAYS;
	}

	private async rowById(id: string): Promise<InviteRow | null> {
		return this.db
			.prepare('SELECT * FROM user_invites WHERE tenant_id = ?1 AND id = ?2')
			.bind(this.tenantId, id)
			.first<InviteRow>();
	}

	private async requireRow(id: string): Promise<InviteRow> {
		const row = await this.rowById(id);
		if (!row) throw new InviteError(404, 'not_found', 'Invite not found');
		return row;
	}

	async get(id: string): Promise<{ invite: Invite; user: InviteUser | null }> {
		const row = await this.requireRow(id);
		return { invite: toInvite(row, this.now()), user: await this.userById(row.user_id) };
	}

	private async userById(id: string): Promise<InviteUser | null> {
		return this.db
			.prepare('SELECT id, email, name, status FROM users WHERE tenant_id = ?1 AND id = ?2')
			.bind(this.tenantId, id)
			.first<InviteUser>();
	}

	/** Role names → ids: only INVITE_GRANTABLE_ROLES, and only roles that exist in this tenant. */
	private async grantableRoleIds(names: unknown): Promise<string[]> {
		if (!Array.isArray(names)) throw new InviteError(400, 'invalid_request', 'roles must be a list of role names');
		const ids: string[] = [];
		for (const name of new Set(names)) {
			const id = typeof name === 'string' && Object.hasOwn(INVITE_GRANTABLE_ROLES, name) ? INVITE_GRANTABLE_ROLES[name] : undefined;
			if (!id) throw new InviteError(403, 'role_not_grantable', `An invite cannot give the role ${String(name)}`);
			const exists = await this.db.prepare('SELECT id FROM rbac_roles WHERE id = ?1 AND tenant_id = ?2').bind(id, this.tenantId).first();
			if (!exists) throw new InviteError(400, 'unknown_role', `The role ${name} does not exist yet`);
			ids.push(id);
		}
		return ids;
	}

	/**
	 * Pre-provisions the account and its invite with the app's ids. Idempotent
	 * on inviteId (a retried queue message gets the same invite back, created =
	 * false). Refuses an email that already belongs to an account (409
	 * user_exists, with the account, so the admin can give it the role/channel
	 * instead) or that has a live invite (409 already_invited).
	 */
	async create(
		input: CreateInviteInput,
		actor: InviteActor
	): Promise<{ invite: Invite; user: InviteUser; token: string | null; created: boolean }> {
		const email = normalizeInviteEmail(String(input.email ?? ''));
		if (!isEmailAddress(email)) throw new InviteError(400, 'invalid_email', 'A valid email is required');
		if (!USER_ID_RE.test(String(input.userId ?? ''))) throw new InviteError(400, 'invalid_request', 'userId must be usr_ followed by 32 hex digits');
		if (!INVITE_ID_RE.test(String(input.inviteId ?? ''))) throw new InviteError(400, 'invalid_request', 'inviteId must be inv_ followed by 32 hex digits');
		const name = cleanText(input.name, 120);
		const note = cleanText(input.note, 1000);
		const locale: InviteLocale = input.locale === 'ar' ? 'ar' : 'en';
		const days = ttlDays(input.expiresInDays, this.defaultTtl);
		const details = input.details && typeof input.details === 'object' ? input.details : {};
		const roleIds = await this.grantableRoleIds(input.roles ?? []);

		const replay = await this.rowById(input.inviteId);
		if (replay) {
			if (replay.email !== email || replay.user_id !== input.userId || replay.client_id !== actor.clientId) {
				throw new InviteError(409, 'invite_id_conflict', 'This inviteId belongs to another invite');
			}
			return { invite: toInvite(replay, this.now()), user: (await this.userById(replay.user_id))!, token: null, created: false };
		}
		if (await this.userById(input.userId)) throw new InviteError(409, 'user_id_conflict', 'This userId is already taken');

		const existing = await this.db
			.prepare('SELECT id, email, name, status FROM users WHERE tenant_id = ?1 AND email = ?2 AND deleted_at IS NULL')
			.bind(this.tenantId, email)
			.first<InviteUser>();
		if (existing) {
			if (existing.status === 'invited') {
				const live = await this.db
					.prepare('SELECT * FROM user_invites WHERE tenant_id = ?1 AND user_id = ?2 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1')
					.bind(this.tenantId, existing.id)
					.first<InviteRow>();
				throw new InviteError(409, 'already_invited', 'This email already has an invite', {
					user: existing,
					invite: live ? toInvite(live, this.now()) : null,
				});
			}
			throw new InviteError(409, 'user_exists', 'This email already has an account', { user: existing });
		}

		const now = this.now();
		const { token, hash } = await newInviteToken();
		const metadata = { email_verified: false, invited: true, invited_at: now, invited_by: actor.userId, invite_id: input.inviteId };
		try {
			await this.db.batch([
				this.db
					.prepare(
						`INSERT INTO users (id, tenant_id, email, name, metadata, status, created_at, updated_at, last_login_at, deleted_at, password_reset_required)
						 VALUES (?1, ?2, ?3, ?4, ?5, 'invited', ?6, ?6, NULL, NULL, 0)`
					)
					.bind(input.userId, this.tenantId, email, name, JSON.stringify(metadata), now),
				this.db
					.prepare(
						`INSERT INTO user_invites (id, tenant_id, user_id, email, name, locale, note, client_id, details, continue_url, token_hash,
						   invited_by, invited_by_email, created_at, updated_at, expires_at, last_sent_at, send_count)
						 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14, ?15, NULL, 0)`
					)
					.bind(
						input.inviteId,
						this.tenantId,
						input.userId,
						email,
						name,
						locale,
						note,
						actor.clientId,
						JSON.stringify(details),
						input.continueUrl ?? null,
						hash,
						actor.userId,
						actor.email || null,
						now,
						now + days * DAY_MS
					),
				// Every account is a Member, as after a normal sign-up
				this.db
					.prepare(
						`INSERT OR IGNORE INTO rbac_user_roles (user_id, role_id, tenant_id, assigned_at, assigned_by)
						 SELECT ?1, id, ?2, ?3, ?4 FROM rbac_roles WHERE id = 'role_member' AND tenant_id = ?2`
					)
					.bind(input.userId, this.tenantId, now, 'user_system'),
				...roleIds.map((roleId) =>
					this.db
						.prepare(
							`INSERT OR IGNORE INTO rbac_user_roles (user_id, role_id, tenant_id, assigned_at, assigned_by)
							 VALUES (?1, ?2, ?3, ?4, ?5)`
						)
						.bind(input.userId, roleId, this.tenantId, now, actor.userId)
				),
			]);
		} catch (error) {
			// Someone signed up (or was invited) with this email a moment ago: the unique index let them in first
			if (/UNIQUE constraint failed/i.test(error instanceof Error ? error.message : String(error))) {
				throw new InviteError(409, 'user_exists', 'This email already has an account');
			}
			throw error;
		}
		return {
			invite: toInvite(await this.requireRow(input.inviteId), now),
			user: { id: input.userId, email, name, status: 'invited' },
			token,
			created: true,
		};
	}

	/** The invites with these ids (the app's status sync). */
	async byIds(ids: string[]): Promise<Invite[]> {
		const wanted = [...new Set(ids.filter((id) => INVITE_ID_RE.test(id)))].slice(0, 100);
		if (wanted.length === 0) return [];
		const rows = await this.db
			.prepare(`SELECT * FROM user_invites WHERE tenant_id = ?1 AND id IN (${wanted.map((_, i) => `?${i + 2}`).join(',')})`)
			.bind(this.tenantId, ...wanted)
			.all<InviteRow>();
		const now = this.now();
		return (rows.results ?? []).map((r) => toInvite(r, now));
	}

	/** The app's own invites only. */
	async requireOwned(id: string, clientId: string): Promise<Invite> {
		const row = await this.rowById(id);
		if (!row || row.client_id !== clientId) throw new InviteError(404, 'not_found', 'Invite not found');
		return toInvite(row, this.now());
	}

	/** "Copy link": the app made a token and shows its link once; Auth keeps only the hash (the old link stops working). */
	async setLinkHash(id: string, tokenHash: string): Promise<Invite> {
		if (!/^[0-9a-f]{64}$/.test(tokenHash)) throw new InviteError(400, 'invalid_request', 'tokenHash must be a SHA-256 hex digest');
		const row = await this.requireRow(id);
		if (row.deleted_at !== null) throw new InviteError(410, 'revoked', 'This invite was revoked; restore it first');
		if (row.accepted_at !== null) throw new InviteError(409, 'already_accepted', 'This invite was already accepted');
		const now = this.now();
		await this.db
			.prepare(
				`UPDATE user_invites SET token_hash = ?3, token_used_at = NULL, expires_at = MAX(expires_at, ?4), updated_at = ?5
				 WHERE tenant_id = ?1 AND id = ?2`
			)
			.bind(this.tenantId, id, tokenHash, now + this.defaultTtl * DAY_MS, now)
			.run();
		return toInvite(await this.requireRow(id), now);
	}

	async list(params: ListInvitesParams = {}): Promise<{ invites: Invite[]; nextCursor: string | null }> {
		const now = this.now();
		const limit = Math.min(Math.max(params.limit ?? 50, 1), 100);
		const where: string[] = ['tenant_id = ?1'];
		const binds: unknown[] = [this.tenantId];
		const bind = (value: unknown) => {
			binds.push(value);
			return `?${binds.length}`;
		};
		switch (params.status) {
			case 'revoked':
				where.push('deleted_at IS NOT NULL');
				break;
			case 'active':
				where.push('deleted_at IS NULL AND accepted_at IS NOT NULL');
				break;
			case 'expired':
				where.push(`deleted_at IS NULL AND accepted_at IS NULL AND expires_at <= ${bind(now)}`);
				break;
			case 'invited':
				where.push(`deleted_at IS NULL AND accepted_at IS NULL AND expires_at > ${bind(now)}`);
				break;
		}
		if (params.userId) where.push(`user_id = ${bind(params.userId)}`);
		const q = params.q?.trim().toLowerCase();
		if (q) {
			// instr, not LIKE: D1 refuses LIKE patterns over 50 bytes, and an invited address can be longer
			const text = bind(q);
			where.push(`(instr(lower(email), ${text}) > 0 OR instr(lower(COALESCE(name, '')), ${text}) > 0 OR id = ${text} OR user_id = ${bind(params.q!.trim())})`);
		}
		if (params.cursor) {
			const [at, id] = params.cursor.split('|');
			const createdAt = Number(at);
			if (Number.isFinite(createdAt) && id) where.push(`(created_at < ${bind(createdAt)} OR (created_at = ${bind(createdAt)} AND id < ${bind(id)}))`);
		}
		const rows = await this.db
			.prepare(`SELECT * FROM user_invites WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ${bind(limit + 1)}`)
			.bind(...binds)
			.all<InviteRow>();
		const results = rows.results ?? [];
		const page = results.slice(0, limit);
		const last = page[page.length - 1];
		return {
			invites: page.map((r) => toInvite(r, now)),
			nextCursor: results.length > limit && last ? `${last.created_at}|${last.id}` : null,
		};
	}

	/** A new link token (the old link stops working). Optionally extends the expiry. */
	async rotateToken(id: string, opts: { extend?: boolean; locale?: string; sent?: boolean } = {}): Promise<{ invite: Invite; token: string }> {
		const row = await this.requireRow(id);
		const now = this.now();
		if (row.deleted_at !== null) throw new InviteError(410, 'revoked', 'This invite was revoked; restore it first');
		if (row.accepted_at !== null) throw new InviteError(409, 'already_accepted', 'This invite was already accepted');
		const { token, hash } = await newInviteToken();
		const expires = opts.extend ? Math.max(row.expires_at, now + this.defaultTtl * DAY_MS) : row.expires_at;
		const locale = opts.locale === 'ar' || opts.locale === 'en' ? opts.locale : row.locale;
		await this.db
			.prepare(
				`UPDATE user_invites SET token_hash = ?3, token_used_at = NULL, expires_at = ?4, locale = ?5, updated_at = ?6,
				   last_sent_at = CASE WHEN ?7 THEN ?6 ELSE last_sent_at END,
				   send_count = send_count + CASE WHEN ?7 THEN 1 ELSE 0 END
				 WHERE tenant_id = ?1 AND id = ?2`
			)
			.bind(this.tenantId, id, hash, expires, locale, now, opts.sent ? 1 : 0)
			.run();
		return { invite: toInvite(await this.requireRow(id), now), token };
	}

	async markSent(id: string): Promise<void> {
		const now = this.now();
		await this.db
			.prepare('UPDATE user_invites SET last_sent_at = ?3, send_count = send_count + 1, updated_at = ?3 WHERE tenant_id = ?1 AND id = ?2')
			.bind(this.tenantId, id, now)
			.run();
	}

	/** Records what the admin set up for the invite (channels, plan): shown in the invites list. */
	async updateDetails(id: string, patch: { details?: Record<string, unknown>; note?: string | null }): Promise<Invite> {
		const row = await this.requireRow(id);
		const details = { ...parseJson<Record<string, unknown>>(row.details, {}), ...(patch.details ?? {}) };
		const note = patch.note === undefined ? row.note : cleanText(patch.note, 1000);
		const now = this.now();
		await this.db
			.prepare('UPDATE user_invites SET details = ?3, note = ?4, updated_at = ?5 WHERE tenant_id = ?1 AND id = ?2')
			.bind(this.tenantId, id, JSON.stringify(details), note, now)
			.run();
		return toInvite(await this.requireRow(id), now);
	}

	/**
	 * Revoke: soft deletes the invite and, while it was never used, its account
	 * (status deleted, so the email is free and nothing can claim it). Accepted
	 * invites cannot be revoked: the account is a normal account by then.
	 */
	async revoke(id: string, actor: InviteActor, reason?: string | null): Promise<Invite> {
		const row = await this.requireRow(id);
		if (row.deleted_at !== null) return toInvite(row, this.now());
		if (row.accepted_at !== null) throw new InviteError(409, 'already_accepted', 'This invite was already accepted; manage the account instead');
		const now = this.now();
		const why = cleanText(reason, 500);
		const statements = [
			this.db
				.prepare(
					`UPDATE user_invites SET deleted_at = ?3, deleted_by = ?4, deleted_by_email = ?5, deleted_reason = ?6, token_hash = NULL, updated_at = ?3
					 WHERE tenant_id = ?1 AND id = ?2 AND deleted_at IS NULL`
				)
				.bind(this.tenantId, id, now, actor.userId, actor.email || null, why),
		];
		// The unused account is an admin soft delete like any other (admin_deletions, #293): it shows
		// in Auth's Recently deleted, and that cleanup removes everything keyed by the user.
		const account = await this.userById(row.user_id);
		if (account?.status === 'invited') {
			statements.push(
				this.db
					.prepare(
						`UPDATE users SET status = 'deleted', deleted_at = ?3, updated_at = ?3
						 WHERE tenant_id = ?1 AND id = ?2 AND status = 'invited' AND deleted_at IS NULL`
					)
					.bind(this.tenantId, row.user_id, now),
				new DeletionStore(this.db).insertStatement({
					kind: 'user',
					itemId: row.user_id,
					tenantId: this.tenantId,
					label: row.email,
					deletedBy: actor.userId,
					deletedByEmail: actor.email || null,
					reason: why ? `Invite revoked: ${why}` : 'Invite revoked',
					snapshot: { status: 'invited', email: row.email },
					now,
				})
			);
		}
		await this.db.batch(statements);
		return toInvite(await this.requireRow(id), now);
	}

	/** Undo a revoke (within the 30 days): the invite and its account come back; the email must still be free. */
	async restore(id: string): Promise<Invite> {
		const row = await this.requireRow(id);
		if (row.deleted_at === null) return toInvite(row, this.now());
		const taken = await this.db
			.prepare('SELECT id FROM users WHERE tenant_id = ?1 AND email = ?2 AND deleted_at IS NULL AND id != ?3')
			.bind(this.tenantId, row.email, row.user_id)
			.first<{ id: string }>();
		if (taken) throw new InviteError(409, 'email_taken', 'Another account now uses this email', { userId: taken.id });
		const now = this.now();
		await this.db.batch([
			new DeletionStore(this.db).removeStatement('user', row.user_id),
			this.db
				.prepare(
					`UPDATE user_invites SET deleted_at = NULL, deleted_by = NULL, deleted_by_email = NULL, deleted_reason = NULL,
					   purge_requested_at = NULL, purge_requested_by = NULL, updated_at = ?3
					 WHERE tenant_id = ?1 AND id = ?2`
				)
				.bind(this.tenantId, id, now),
			this.db
				.prepare(
					`UPDATE users SET status = 'invited', deleted_at = NULL, updated_at = ?3
					 WHERE tenant_id = ?1 AND id = ?2 AND status = 'deleted' AND last_login_at IS NULL`
				)
				.bind(this.tenantId, row.user_id, now),
		]);
		return toInvite(await this.requireRow(id), now);
	}

	/** "Delete permanently now": queues a revoked invite for the cleanup's next run (still restorable until then). */
	async requestPurge(id: string, actor: InviteActor, confirm: string | undefined): Promise<Invite> {
		const row = await this.requireRow(id);
		if (row.deleted_at === null) throw new InviteError(409, 'not_revoked', 'Revoke the invite first');
		if (normalizeInviteEmail(confirm ?? '') !== row.email) throw new InviteError(400, 'confirm_mismatch', 'Type the invite email to confirm');
		const now = this.now();
		await this.db
			.prepare('UPDATE user_invites SET purge_requested_at = ?3, purge_requested_by = ?4, updated_at = ?3 WHERE tenant_id = ?1 AND id = ?2')
			.bind(this.tenantId, id, now, actor.userId)
			.run();
		await new DeletionStore(this.db).requestPurge('user', row.user_id, actor.userId, now);
		return toInvite(await this.requireRow(id), now);
	}

	/** The invite a link token belongs to (any state), or null. */
	async byToken(token: string): Promise<InviteRow | null> {
		if (!/^[0-9a-f]{64}$/.test(token)) return null;
		return this.db.prepare('SELECT * FROM user_invites WHERE token_hash = ?1').bind(await hashToken(token)).first<InviteRow>();
	}

	/** Spends a link token (single use). False when it was already spent (a concurrent click won). */
	async useToken(id: string): Promise<boolean> {
		const now = this.now();
		const result = await this.db
			.prepare('UPDATE user_invites SET token_used_at = ?2, token_hash = NULL, updated_at = ?2 WHERE id = ?1 AND token_hash IS NOT NULL AND token_used_at IS NULL')
			.bind(id, now)
			.run();
		return (result.meta?.changes ?? 0) > 0;
	}

	static view(row: InviteRow, now = Date.now()): Invite {
		return toInvite(row, now);
	}
}

/**
 * First sign-in of an invited account (issuer onSuccess): status active, email
 * verified (the sign-in proved the address), invite accepted. Idempotent; false
 * when the account was not (or no longer) an invited one.
 */
export async function claimInvitedAccount(db: D1Database, tenantId: string, userId: string, now = Date.now()): Promise<boolean> {
	const [user] = await db.batch([
		db
			.prepare(
				`UPDATE users SET status = 'active',
				   metadata = json_set(COALESCE(metadata, '{}'), '$.email_verified', json('true'), '$.email_verified_at', ?3, '$.invite_accepted_at', ?3),
				   updated_at = ?3, last_login_at = ?3
				 WHERE tenant_id = ?1 AND id = ?2 AND status = 'invited' AND deleted_at IS NULL`
			)
			.bind(tenantId, userId, now),
		db
			.prepare(
				`UPDATE user_invites SET accepted_at = ?3, token_hash = NULL, updated_at = ?3
				 WHERE tenant_id = ?1 AND user_id = ?2 AND accepted_at IS NULL AND deleted_at IS NULL`
			)
			.bind(tenantId, userId, now),
	]);
	return (user.meta?.changes ?? 0) > 0;
}

/**
 * Hourly cleanup: revoked invites 30+ days old, or queued with "Delete
 * permanently now", are removed with their never-used account (users row and
 * role links). An account that somehow signed in is kept; only the invite goes.
 */
export async function purgeRevokedInvites(db: D1Database, now = Date.now(), batchSize = 25): Promise<{ purged: number; failed: number }> {
	const due = await db
		.prepare(
			`SELECT id, user_id FROM user_invites
			 WHERE deleted_at IS NOT NULL AND (purge_requested_at IS NOT NULL OR deleted_at <= ?1)
			 ORDER BY deleted_at LIMIT ?2`
		)
		.bind(now - RETENTION_MS, batchSize)
		.all<{ id: string; user_id: string }>();
	let purged = 0;
	let failed = 0;
	for (const row of due.results ?? []) {
		try {
			await db.batch([
				db
					.prepare(
						`DELETE FROM rbac_user_roles WHERE user_id = ?1 AND EXISTS (
						   SELECT 1 FROM users WHERE id = ?1 AND status = 'deleted' AND last_login_at IS NULL)`
					)
					.bind(row.user_id),
				db.prepare(`DELETE FROM users WHERE id = ?1 AND status = 'deleted' AND last_login_at IS NULL`).bind(row.user_id),
				db.prepare('DELETE FROM user_invites WHERE id = ?1 AND deleted_at IS NOT NULL').bind(row.id),
			]);
			purged++;
			await emitAuditEvent({
				timestamp: new Date(now).toISOString(),
				eventType: AuditEventType.USER_INVITE_PURGED,
				severity: AuditEventSeverity.WARNING,
				userId: 'system',
				ipAddress: null,
				userAgent: null,
				requestId: null,
				success: true,
				errorMessage: null,
				metadata: { inviteId: row.id, targetUserId: row.user_id },
			});
		} catch {
			failed++;
		}
	}
	return { purged, failed };
}
