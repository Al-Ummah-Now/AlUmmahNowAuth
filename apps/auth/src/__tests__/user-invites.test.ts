/**
 * Admin invites (docs/USER_INVITES.md): the provisioning API for client apps,
 * the invite link page, first sign-in claiming the pre-provisioned account,
 * revoke/restore/purge and the 30-day cleanup.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env, createExecutionContext } from 'cloudflare:test';
import { hashClientSecret } from '@al-ummah-now/openauth';
import migration0028 from '../../migrations/0030_user_invites.sql?raw';
import { setupDatabase } from '../test-setup';
import { hashToken } from '../utils/crypto';
import { createOnSuccessHandler } from '../handlers/auth-handlers';
import { D1UserService } from '../services/d1-user-service';
import { claimInvitedAccount, purgeRevokedInvites, RETENTION_MS, InviteService } from '../invites/service';
import { inviteEmailHtml, inviteEmailSubject, inviteEmailText } from '../invites/email';
import type { RBACServiceImpl } from '@al-ummah-now/openauth/rbac/index';
import type { D1UserAdapter } from '@al-ummah-now/openauth';

const sent = vi.hoisted(() => [] as Array<{ to: string; subject: string; html: string; text?: string }>);
vi.mock('../email', () => ({
	default: vi.fn(async (opts: { to: string; subject: string; html: string; text?: string }) => {
		sent.push(opts);
		return { success: true, emailId: `email-${sent.length}` };
	}),
}));
const audit = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../audit-emitter', async (importOriginal) => ({
	...(await importOriginal<typeof import('../audit-emitter')>()),
	emitAuditEvent: audit,
}));

const { routeInviteProvisioning, routeInvitePage, safeContinueUrl } = await import('../invites/routes');

const E = () => ({ ...(env as unknown as Env), RESEND_API_KEY: 're_test_key', OPENAUTH_ISSUER: 'https://auth.test' }) as unknown as Env;
const DB = () => (env as unknown as Env).AUTH_DB;
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

const VIDEOS = { id: 'd7464de8-363d-4fc1-b1af-7c71653f0afc', secret: 'videos-admin-test-secret-0123456789' };
const OTHER = { id: 'other-invite-client', secret: 'other-invite-client-secret-0123456789' };
const NO_SCOPE = { id: 'no-invite-scope-client', secret: 'no-invite-scope-secret-0123456789' };

const basic = (id: string, secret: string) => `Basic ${btoa(`${id}:${secret}`)}`;
const hex = () => crypto.randomUUID().replace(/-/g, '');
const ids = () => ({ inviteId: `inv_${hex()}`, userId: `usr_${hex()}` });

function sqlStatements(sql: string): string[] {
	return sql
		.split('\n')
		.filter((line) => !line.trim().startsWith('--'))
		.join('\n')
		.split(';')
		.map((s) => s.trim())
		.filter(Boolean);
}

async function call(method: string, path: string, json?: unknown, client: { id: string; secret: string } | null = VIDEOS) {
	const headers = new Headers({ 'Content-Type': 'application/json' });
	if (client) headers.set('Authorization', basic(client.id, client.secret));
	const req = new Request(`https://auth.test${path}`, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
	const res = await routeInviteProvisioning(req, E(), ctx, 'req-invite');
	if (!res) throw new Error('not routed');
	return { status: res.status, json: (await res.json()) as Record<string, any> };
}

async function invite(overrides: Record<string, unknown> = {}) {
	const body = { ...ids(), email: `creator-${hex().slice(0, 8)}@example.com`, name: 'New Creator', locale: 'en', actor: { id: 'usr_videosadmin', email: 'admin@example.com' }, ...overrides };
	const res = await call('POST', '/provisioning/invites', body);
	return { res, body };
}

function linkOf(html: string): string {
	const match = /href="(https:\/\/auth\.test\/invite\/[0-9a-f]{64}[^"]*)"/.exec(html);
	if (!match) throw new Error('no invite link in the email');
	return match[1].replace(/&amp;/g, '&');
}

async function page(method: 'GET' | 'POST', link: string) {
	const res = await routeInvitePage(new Request(link, { method }), E(), ctx, 'req-page');
	if (!res) throw new Error('not routed');
	return res;
}

beforeAll(async () => {
	await setupDatabase();
	const db = DB();
	const now = Date.now();
	await db.prepare(`INSERT OR IGNORE INTO rbac_roles (id, name, tenant_id) VALUES ('role_member', 'Member', 'default')`).run();
	await db.prepare('DROP TABLE IF EXISTS user_invites').run();
	for (const [c, scopes] of [
		[VIDEOS, '["moderation:request"]'],
		[OTHER, '["invites:provision"]'],
		[NO_SCOPE, '["moderation:request"]'],
	] as const) {
		await db
			.prepare(`INSERT OR REPLACE INTO oauth_clients (id, tenant_id, name, client_secret_hash, scopes, enabled, created_at, updated_at) VALUES (?, 'default', ?, ?, ?, 1, ?, ?)`)
			.bind(c.id, c.id, await hashClientSecret(c.secret), scopes, now, now)
			.run();
	}
	// The migration under test: the table, and the scope for the videos admin's client only
	for (const stmt of sqlStatements(migration0028)) await db.prepare(stmt).run();
	for (const stmt of sqlStatements(migration0028)) await db.prepare(stmt).run(); // idempotent
});

beforeEach(() => {
	sent.length = 0;
	audit.mockClear();
});

describe('migration 0030', () => {
	it('gives the videos admin client the invites:provision scope once, and nobody else', async () => {
		const row = await DB().prepare('SELECT scopes FROM oauth_clients WHERE id = ?').bind(VIDEOS.id).first<{ scopes: string }>();
		expect(JSON.parse(row!.scopes)).toEqual(['moderation:request', 'invites:provision']);
		const other = await DB().prepare('SELECT scopes FROM oauth_clients WHERE id = ?').bind(NO_SCOPE.id).first<{ scopes: string }>();
		expect(JSON.parse(other!.scopes)).toEqual(['moderation:request']);
	});
});

describe('who may provision', () => {
	it('nobody without client credentials', async () => {
		expect((await call('POST', '/provisioning/invites', {}, null)).status).toBe(401);
	});
	it('not a client without the invites:provision scope', async () => {
		const res = await call('POST', '/provisioning/invites', {}, NO_SCOPE);
		expect(res.status).toBe(403);
		expect(res.json.error).toBe('insufficient_scope');
	});
	it('not with a wrong secret', async () => {
		expect((await call('POST', '/provisioning/invites', {}, { id: VIDEOS.id, secret: 'wrong-secret-0123456789' })).status).toBe(401);
	});
});

describe('POST /provisioning/invites', () => {
	it('pre-provisions a real account with the app\'s id, invited and unverified, and emails a bilingual link', async () => {
		const { res, body } = await invite({ email: '  New.Creator+YT@Example.COM ', locale: 'ar', note: 'Welcome aboard' });
		expect(res.status).toBe(201);
		expect(res.json.user).toMatchObject({ id: body.userId, email: 'new.creator+yt@example.com', status: 'invited' });
		expect(res.json.invite).toMatchObject({ id: body.inviteId, status: 'invited', locale: 'ar', sendCount: 1, clientId: VIDEOS.id });
		expect(res.json.emailSent).toBe(true);

		const user = await DB().prepare('SELECT * FROM users WHERE id = ?').bind(body.userId).first<Record<string, any>>();
		expect(user).toMatchObject({ status: 'invited', email: 'new.creator+yt@example.com', name: 'New Creator', deleted_at: null });
		expect(JSON.parse(user!.metadata)).toMatchObject({ email_verified: false, invited: true, invite_id: body.inviteId });
		const role = await DB().prepare(`SELECT role_id FROM rbac_user_roles WHERE user_id = ?`).bind(body.userId).first<{ role_id: string }>();
		expect(role?.role_id).toBe('role_member');

		expect(sent).toHaveLength(1);
		expect(sent[0].to).toBe('new.creator+yt@example.com');
		expect(sent[0].subject).toBe(inviteEmailSubject('ar'));
		expect(sent[0].html).toContain('Welcome aboard');
		expect(linkOf(sent[0].html)).toMatch(/\?lang=ar$/);
		// Only the hash is stored
		const stored = await DB().prepare('SELECT token_hash FROM user_invites WHERE id = ?').bind(body.inviteId).first<{ token_hash: string }>();
		const token = /\/invite\/([0-9a-f]{64})/.exec(linkOf(sent[0].html))![1];
		expect(stored!.token_hash).toBe(await hashToken(token));
		expect(JSON.stringify(audit.mock.calls)).not.toContain(token);
		expect(audit.mock.calls.map((c) => c[0].eventType)).toContain('user.invited');
	});

	it('is idempotent on inviteId: a retried message gets the same invite and no second email', async () => {
		const { body } = await invite();
		sent.length = 0;
		const again = await call('POST', '/provisioning/invites', body);
		expect(again.status).toBe(200);
		expect(again.json.created).toBe(false);
		expect(again.json.invite.id).toBe(body.inviteId);
		expect(sent).toHaveLength(0);
	});

	it('refuses an email that already has an account, case and spaces aside, and says which', async () => {
		await DB()
			.prepare(`INSERT INTO users (id, tenant_id, email, status, created_at, updated_at) VALUES ('usr_existing_member', 'default', 'member@example.com', 'active', 1, 1)`)
			.run();
		const res = (await invite({ email: ' MEMBER@example.com' })).res;
		expect(res.status).toBe(409);
		expect(res.json.error).toBe('user_exists');
		expect(res.json.user.id).toBe('usr_existing_member');
	});

	it('refuses a second invite for the same email (already_invited), never a second account', async () => {
		const first = await invite({ email: 'twice@example.com' });
		const res = (await invite({ email: 'Twice@Example.com' })).res;
		expect(res.status).toBe(409);
		expect(res.json.error).toBe('already_invited');
		expect(res.json.invite.id).toBe(first.body.inviteId);
		const count = await DB().prepare(`SELECT COUNT(*) AS n FROM users WHERE email = 'twice@example.com'`).first<{ n: number }>();
		expect(count!.n).toBe(1);
	});

	it('validates the ids, the email and the expiry', async () => {
		expect((await invite({ userId: 'usr_1' })).res.json.error).toBe('invalid_request');
		expect((await invite({ inviteId: 'nope' })).res.json.error).toBe('invalid_request');
		expect((await invite({ email: 'not-an-email' })).res.json.error).toBe('invalid_email');
		expect((await invite({ expiresInDays: 365 })).res.status).toBe(400);
	});

	it('honours expiresInDays (default 14)', async () => {
		const before = Date.now();
		const res = (await invite()).res;
		expect(res.json.invite.expiresAt).toBeGreaterThanOrEqual(before + 14 * 86400_000);
		const short = (await invite({ expiresInDays: 3 })).res;
		expect(short.json.invite.expiresAt).toBeLessThan(before + 4 * 86400_000);
	});
});

describe('another client', () => {
	it('cannot see or change this client\'s invites', async () => {
		const { body } = await invite();
		expect((await call('POST', `/provisioning/invites/${body.inviteId}/revoke`, {}, OTHER)).status).toBe(404);
		const list = await call('GET', `/provisioning/invites?ids=${body.inviteId}`, undefined, OTHER);
		expect(list.json.invites).toEqual([]);
		const mine = await call('GET', `/provisioning/invites?ids=${body.inviteId}`);
		expect(mine.json.invites.map((i: { id: string }) => i.id)).toEqual([body.inviteId]);
	});
});

describe('the invite link', () => {
	it('GET shows the page and spends nothing; POST spends it once and goes to the app\'s sign-in', async () => {
		await invite({ email: 'link@example.com', continueUrl: 'http://localhost:3000/api/auth/login?prompt=login' });
		const link = linkOf(sent[0].html);
		for (let i = 0; i < 2; i++) {
			const res = await page('GET', link);
			expect(res.status).toBe(200);
			expect(await res.text()).toContain('link@example.com');
		}
		const go = await page('POST', link);
		expect(go.status).toBe(303);
		expect(go.headers.get('Location')).toBe('http://localhost:3000/api/auth/login?prompt=login');
		const again = await page('POST', link);
		expect(again.status).toBe(410);
		expect(await again.text()).toContain('sign in with the email address');
	});

	it('an expired link explains that signing in still works', async () => {
		const { body } = await invite();
		const link = linkOf(sent[0].html);
		await DB().prepare('UPDATE user_invites SET expires_at = 1 WHERE id = ?').bind(body.inviteId).run();
		const res = await page('GET', link);
		expect(res.status).toBe(410);
		const list = await call('GET', `/provisioning/invites?ids=${body.inviteId}`);
		expect(list.json.invites[0].status).toBe('expired');
	});

	it('is in Arabic only with ?lang=ar', async () => {
		await invite({ locale: 'ar' });
		const link = linkOf(sent[0].html);
		expect(await (await page('GET', link)).text()).toContain('دعوة للانضمام');
		expect(await (await page('GET', link.replace('?lang=ar', ''))).text()).toContain('invited to Al Ummah Now');
	});

	it('resend makes a new link (the old one stops working) and emails it again', async () => {
		const { body } = await invite();
		const old = linkOf(sent[0].html);
		const res = await call('POST', `/provisioning/invites/${body.inviteId}/resend`, { actor: { id: 'usr_videosadmin' } });
		expect(res.status).toBe(200);
		expect(res.json.invite.sendCount).toBe(2);
		expect((await page('GET', old)).status).toBe(410);
		expect((await page('GET', linkOf(sent[1].html))).status).toBe(200);
	});

	it('copy link: the app\'s token hash replaces the emailed one', async () => {
		const { body } = await invite();
		const emailed = linkOf(sent[0].html);
		const token = 'a'.repeat(64);
		const res = await call('POST', `/provisioning/invites/${body.inviteId}/link`, { tokenHash: await hashToken(token) });
		expect(res.status).toBe(200);
		expect((await page('GET', emailed)).status).toBe(410);
		expect((await page('GET', `https://auth.test/invite/${token}`)).status).toBe(200);
	});

	it('only goes to our own apps', () => {
		const e = { ...E(), ALLOWED_ORIGINS: '*.qa.alummahnow.net', ENVIRONMENT: 'production' } as Env;
		expect(safeContinueUrl('https://videos.qa.alummahnow.net/api/auth/login', e)).toBe('https://videos.qa.alummahnow.net/api/auth/login');
		expect(safeContinueUrl('https://evil.example.com/', e)).toBeNull();
		expect(safeContinueUrl('http://localhost:3000/', e)).toBeNull();
		expect(safeContinueUrl('javascript:alert(1)', e)).toBeNull();
	});
});

describe('first sign-in claims the invited account', () => {
	const subject = vi.fn(async () => new Response(null, { status: 302, headers: { Location: 'https://app.test/cb' } }));

	function onSuccess() {
		const db = DB();
		const users = new D1UserService({ db, adapter: { revokeAllUserSessions: async () => ({ deletedCount: 0 }) } as unknown as D1UserAdapter });
		const createUser = vi.spyOn(users, 'createUser');
		const rbac = {
			getUserRoles: vi.fn(async (userId: string) => {
				const rows = await db.prepare('SELECT r.name FROM rbac_user_roles ur JOIN rbac_roles r ON r.id = ur.role_id WHERE ur.user_id = ?').bind(userId).all<{ name: string }>();
				return rows.results ?? [];
			}),
			assignRoleToUser: vi.fn(),
		} as unknown as RBACServiceImpl;
		const handler = createOnSuccessHandler(users, rbac, {
			request: new Request('https://auth.test/password/register', { method: 'POST' }),
			env: {},
			ctx: createExecutionContext(),
			requestId: 'req-claim',
			db,
			homeUrl: 'https://alummahnow.net/',
		});
		return { handler, createUser };
	}

	for (const provider of ['password', 'code']) {
		it(`provider "${provider}" with the invited email (any case) lands in the same account, now active and verified`, async () => {
			const { body } = await invite({ email: `claim-${provider}@example.com` });
			const { handler, createUser } = onSuccess();
			subject.mockClear();
			const res = await handler({ subject }, { provider, properties: { email: `Claim-${provider}@Example.com` }, tenantId: 'default', roles: [] }, { id: 'default' });
			expect(res.status).toBe(302);
			expect(createUser).not.toHaveBeenCalled();
			expect(subject).toHaveBeenCalledWith('user', expect.objectContaining({ id: body.userId, roles: ['Member'] }));
			const user = await DB().prepare('SELECT status, metadata, last_login_at FROM users WHERE id = ?').bind(body.userId).first<Record<string, any>>();
			expect(user!.status).toBe('active');
			expect(JSON.parse(user!.metadata)).toMatchObject({ email_verified: true, invite_id: body.inviteId });
			expect(user!.last_login_at).toBeGreaterThan(0);
			const list = await call('GET', `/provisioning/invites?ids=${body.inviteId}`);
			expect(list.json.invites[0].status).toBe('active');
			const count = await DB().prepare('SELECT COUNT(*) AS n FROM users WHERE email = ?').bind(`claim-${provider}@example.com`).first<{ n: number }>();
			expect(count!.n).toBe(1);
		});
	}

	it('an expired invite still lets the person claim the account', async () => {
		const { body } = await invite({ email: 'late@example.com' });
		await DB().prepare('UPDATE user_invites SET expires_at = 1 WHERE id = ?').bind(body.inviteId).run();
		const { handler } = onSuccess();
		const res = await handler({ subject }, { provider: 'password', properties: { email: 'late@example.com' }, tenantId: 'default', roles: [] }, { id: 'default' });
		expect(res.status).toBe(302);
		expect((await DB().prepare('SELECT status FROM users WHERE id = ?').bind(body.userId).first<{ status: string }>())!.status).toBe('active');
	});

	it('claiming is idempotent', async () => {
		const { body } = await invite();
		expect(await claimInvitedAccount(DB(), 'default', body.userId)).toBe(true);
		expect(await claimInvitedAccount(DB(), 'default', body.userId)).toBe(false);
	});

	it('an accepted invite cannot be revoked', async () => {
		const { body } = await invite();
		await claimInvitedAccount(DB(), 'default', body.userId);
		expect((await call('POST', `/provisioning/invites/${body.inviteId}/revoke`, {})).json.error).toBe('already_accepted');
	});
});

describe('revoke, restore, purge', () => {
	it('revoke soft deletes the invite and its unused account, so the email is free and nothing can claim it', async () => {
		const { body } = await invite({ email: 'revoked@example.com' });
		const link = linkOf(sent[0].html);
		const res = await call('POST', `/provisioning/invites/${body.inviteId}/revoke`, { reason: 'Wrong address', actor: { id: 'usr_videosadmin', email: 'admin@example.com' } });
		expect(res.json.invite).toMatchObject({ status: 'revoked', deletedBy: 'usr_videosadmin', deletedReason: 'Wrong address' });
		expect(res.json.invite.purgeAfter).toBe(res.json.invite.deletedAt + RETENTION_MS);
		const user = await DB().prepare('SELECT status, deleted_at FROM users WHERE id = ?').bind(body.userId).first<Record<string, any>>();
		expect(user!.status).toBe('deleted');
		expect(user!.deleted_at).toBeGreaterThan(0);
		expect((await page('GET', link)).status).toBe(410);
		// A normal sign-up with the email is possible again
		const users = new D1UserService({ db: DB(), adapter: {} as D1UserAdapter });
		expect(await users.getUserByEmail('default', 'revoked@example.com')).toBeNull();
	});

	it('restore brings both back while the email is still free, and refuses when it is taken', async () => {
		const { body } = await invite({ email: 'restore@example.com' });
		await call('POST', `/provisioning/invites/${body.inviteId}/revoke`, {});
		const res = await call('POST', `/provisioning/invites/${body.inviteId}/restore`, {});
		expect(res.json.invite.status).toBe('invited');
		expect((await DB().prepare('SELECT status FROM users WHERE id = ?').bind(body.userId).first<{ status: string }>())!.status).toBe('invited');

		await call('POST', `/provisioning/invites/${body.inviteId}/revoke`, {});
		await DB().prepare(`INSERT INTO users (id, tenant_id, email, status, created_at, updated_at) VALUES ('usr_took_email', 'default', 'restore@example.com', 'active', 1, 1)`).run();
		const refused = await call('POST', `/provisioning/invites/${body.inviteId}/restore`, {});
		expect(refused.status).toBe(409);
		expect(refused.json.error).toBe('email_taken');
	});

	it('"delete permanently now" needs the email typed, only queues it, and the cleanup purges it', async () => {
		const { body } = await invite({ email: 'purge@example.com' });
		expect((await call('POST', `/provisioning/invites/${body.inviteId}/purge`, { confirm: 'purge@example.com' })).json.error).toBe('not_revoked');
		await call('POST', `/provisioning/invites/${body.inviteId}/revoke`, {});
		expect((await call('POST', `/provisioning/invites/${body.inviteId}/purge`, { confirm: 'other@example.com' })).json.error).toBe('confirm_mismatch');
		const queued = await call('POST', `/provisioning/invites/${body.inviteId}/purge`, { confirm: 'PURGE@example.com' });
		expect(queued.json.invite.purgeRequestedAt).toBeGreaterThan(0);
		expect(queued.json.invite.status).toBe('revoked');

		const result = await purgeRevokedInvites(DB());
		expect(result.purged).toBeGreaterThanOrEqual(1);
		expect(await DB().prepare('SELECT id FROM user_invites WHERE id = ?').bind(body.inviteId).first()).toBeNull();
		expect(await DB().prepare('SELECT id FROM users WHERE id = ?').bind(body.userId).first()).toBeNull();
		expect(await DB().prepare('SELECT user_id FROM rbac_user_roles WHERE user_id = ?').bind(body.userId).first()).toBeNull();
	});

	it('the cleanup waits 30 days after a revoke', async () => {
		const { body } = await invite();
		await call('POST', `/provisioning/invites/${body.inviteId}/revoke`, {});
		const service = new InviteService(DB());
		const { invite: revoked } = await service.get(body.inviteId);
		await purgeRevokedInvites(DB(), revoked.deletedAt! + RETENTION_MS - 1000);
		expect(await DB().prepare('SELECT id FROM user_invites WHERE id = ?').bind(body.inviteId).first()).not.toBeNull();
		await purgeRevokedInvites(DB(), revoked.deletedAt! + RETENTION_MS + 1000);
		expect(await DB().prepare('SELECT id FROM user_invites WHERE id = ?').bind(body.inviteId).first()).toBeNull();
	});
});

describe('the invite email', () => {
	const data = { email: 'x@example.com', name: '<b>Ali</b>', link: 'https://auth.test/invite/abc', expiresAt: Date.UTC(2026, 10, 24), note: null, locale: 'en' as const };
	it('has both languages, the chosen one first, and escapes what the admin typed', () => {
		const html = inviteEmailHtml(data);
		expect(html.indexOf('lang="en"')).toBeLessThan(html.indexOf('dir="rtl"'));
		expect(html).toContain('&lt;b&gt;Ali&lt;/b&gt;');
		expect(inviteEmailHtml({ ...data, locale: 'ar' }).indexOf('dir="rtl"')).toBeLessThan(inviteEmailHtml({ ...data, locale: 'ar' }).indexOf('dir="ltr"'));
		expect(inviteEmailText(data)).toContain('https://auth.test/invite/abc');
		expect(inviteEmailSubject('en')).toMatch(/^You're invited/);
	});
});
