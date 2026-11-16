/**
 * Admin invites (docs/USER_INVITES.md): the provisioning API for client apps,
 * the invite link page, first sign-in claiming the pre-provisioned account,
 * revoke/restore/purge and the 30-day cleanup.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env, createExecutionContext } from 'cloudflare:test';
import { hashClientSecret } from '@al-ummah-now/openauth';
import migration0030 from '../../migrations/0030_user_invites.sql?raw';
import { setupDatabase } from '../test-setup';
import { hashToken } from '../utils/crypto';
import { Storage } from '@al-ummah-now/openauth/storage/storage';
import { authStorage } from '../storage/auth-storage';
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

const E = () => ({ ...(env as unknown as Env), RESEND_API_KEY: 're_test_key', OPENAUTH_ISSUER: 'https://auth.test', SESSION_SECRET: 'ab'.repeat(32) }) as unknown as Env;
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

async function page(method: 'GET' | 'POST', link: string, init: { cookie?: string; form?: Record<string, string>; origin?: string } = {}) {
	const headers = new Headers();
	if (init.cookie) headers.set('Cookie', init.cookie);
	if (init.origin) headers.set('Origin', init.origin);
	let body: FormData | undefined;
	if (init.form) {
		body = new FormData();
		for (const [k, v] of Object.entries(init.form)) body.set(k, v);
	}
	const res = await routeInvitePage(new Request(link, { method, headers, body }), E(), ctx, 'req-page');
	if (!res) throw new Error('not routed');
	return res;
}

/** The cookies a response sets, as one Cookie header (name=value pairs). */
function cookiesOf(res: Response): Record<string, string> {
	const out: Record<string, string> = {};
	for (const c of res.headers.getSetCookie()) {
		const [pair] = c.split(';');
		const i = pair.indexOf('=');
		out[pair.slice(0, i)] = pair.slice(i + 1);
	}
	return out;
}
const cookieHeader = (jar: Record<string, string>) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

/** A browser: GET the page (keeps its cookies and the form's CSRF token), then POST that form. */
async function openAndSubmit(link: string, jar: Record<string, string> = {}, path?: string) {
	const shown = await page('GET', link, { cookie: cookieHeader(jar) });
	Object.assign(jar, cookiesOf(shown));
	const html = await shown.text();
	const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(html)?.[1];
	const action = /<form[^>]*action="([^"]+)"/.exec(html)?.[1]?.replace(/&amp;/g, '&');
	if (!csrf || !action) return { shown, html, res: null as Response | null, jar };
	const res = await page('POST', `https://auth.test${path ?? action}`, { cookie: cookieHeader(jar), form: { csrf } });
	Object.assign(jar, cookiesOf(res));
	return { shown, html, res, jar, csrf, action };
}

const stateOf = (html: string) => /data-state="([a-z-]+)"/.exec(html)?.[1];

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
	for (const stmt of sqlStatements(migration0030)) await db.prepare(stmt).run();
	for (const stmt of sqlStatements(migration0030)) await db.prepare(stmt).run(); // idempotent
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
	it('pre-provisions a real account with the app\'s id, invited and unverified, and emails the link in the invite\'s language', async () => {
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

	it('names the attached channel, and says "creator account" when none is attached', async () => {
		await invite({ details: { channels: [{ id: 'ch1', name: 'Noor <Talks>', action: 'created' }] } });
		expect(sent[0].text).toContain('the channel Noor <Talks>');
		expect(sent[0].html).toContain('Noor &lt;Talks&gt;');
		await invite();
		expect(sent[1].text).toContain('creator account');
		expect(sent[1].text).not.toMatch(/channel/i);
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

	it('gives only allow-listed roles (Scholar), never privileged ones', async () => {
		await DB().prepare(`INSERT OR IGNORE INTO rbac_roles (id, name, tenant_id) VALUES ('role_scholar', 'Scholar', 'default')`).run();
		const { res, body } = await invite({ roles: ['Scholar'] });
		expect(res.status).toBe(201);
		const roles = await DB().prepare('SELECT role_id FROM rbac_user_roles WHERE user_id = ? ORDER BY role_id').bind(body.userId).all<{ role_id: string }>();
		expect(roles.results.map((r) => r.role_id)).toEqual(['role_member', 'role_scholar']);
		for (const role of ['Admin', 'Super Admin', 'Moderator', 'constructor']) {
			const refused = (await invite({ roles: [role] })).res;
			expect(refused.status).toBe(403);
			expect(refused.json.error).toBe('role_not_grantable');
		}
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

describe('E2E run addresses', () => {
	const RUN_EMAIL = `e2e+12345-1-admin-chromium-invite-${hex().slice(0, 6)}@e2e.alummahnow.net`;
	const runEnv = () =>
		({
			...E(),
			E2E_RUN_USERS: 'enabled',
			E2E_CODE_SINK_SECRET: { get: async () => 'invite-test-sink-secret-0123456789' },
			TEST_PROMOTE_SECRET: 'invite-test-promote-secret-0123456789',
		}) as unknown as Env;
	const marker = async (userId: string) =>
		(await DB().prepare(`SELECT json_extract(metadata, '$.e2eRun') AS m FROM users WHERE id = ?`).bind(userId).first<{ m: string | null }>())?.m ?? null;

	it('an invited run address is marked as a run account where run accounts are on, so the teardown may delete it', async () => {
		const body = { ...ids(), email: RUN_EMAIL, name: 'Run invitee', locale: 'en', actor: { id: 'usr_videosadmin', email: 'admin@example.com' } };
		const headers = new Headers({ 'Content-Type': 'application/json', Authorization: basic(VIDEOS.id, VIDEOS.secret) });
		const res = await routeInviteProvisioning(new Request('https://auth.test/provisioning/invites', { method: 'POST', headers, body: JSON.stringify(body) }), runEnv(), ctx, 'req-run');
		expect(res!.status).toBe(201);
		expect(JSON.parse((await marker(body.userId))!)).toMatchObject({ via: 'invite' });
	});

	it('never where run accounts are off (production), nor for an ordinary address', async () => {
		const run = { ...ids(), email: `e2e+12345-1-admin-chromium-invite-${hex().slice(0, 6)}@e2e.alummahnow.net` };
		expect((await invite(run)).res.status).toBe(201);
		expect(await marker(run.userId)).toBeNull();
		const plain = ids();
		const headers = new Headers({ 'Content-Type': 'application/json', Authorization: basic(VIDEOS.id, VIDEOS.secret) });
		const body = { ...plain, email: `creator-${hex().slice(0, 8)}@example.com`, name: 'Plain', locale: 'en', actor: { id: 'usr_videosadmin', email: 'admin@example.com' } };
		expect((await routeInviteProvisioning(new Request('https://auth.test/provisioning/invites', { method: 'POST', headers, body: JSON.stringify(body) }), runEnv(), ctx, 'req-plain'))!.status).toBe(201);
		expect(await marker(plain.userId)).toBeNull();
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
	it('GET shows "Your account is ready" and spends nothing; Continue signs in directly and offers a passkey', async () => {
		const { body } = await invite({ email: 'link@example.com', continueUrl: 'http://localhost:3000/api/auth/login?prompt=login&return=%2Fen%2Fstudio' });
		const link = linkOf(sent[0].html);
		for (let i = 0; i < 2; i++) {
			const res = await page('GET', link);
			expect(res.status).toBe(200);
			const html = await res.text();
			expect(stateOf(html)).toBe('ready');
			expect(html).toContain('link@example.com');
			expect(html).not.toContain('Create account');
		}
		const { res } = await openAndSubmit(link);
		expect(res!.status).toBe(200);
		const offer = await res!.text();
		// The passkey offer, with Skip; then the app's sign-in without prompt=login (single sign-on finishes it)
		expect(offer).toContain('data-page="passkey"');
		expect(offer).toContain('>Skip<');
		expect(offer).toContain('"continueUrl":"http://localhost:3000/api/auth/login?return=%2Fen%2Fstudio"');
		expect(offer).not.toMatch(/password/i);
		const session = res!.headers.getSetCookie().find((c) => c.startsWith('__session='));
		expect(session).toMatch(/HttpOnly/);
		// Claimed: active, verified, accepted; the token spent; a browser session holding only this account
		const user = await DB().prepare('SELECT status, metadata FROM users WHERE id = ?').bind(body.userId).first<Record<string, any>>();
		expect(user!.status).toBe('active');
		expect(JSON.parse(user!.metadata).email_verified).toBe(true);
		const row = await DB().prepare('SELECT accepted_at, token_used_at FROM user_invites WHERE id = ?').bind(body.inviteId).first<Record<string, any>>();
		expect(row!.accepted_at).toBeGreaterThan(0);
		expect(row!.token_used_at).toBeGreaterThan(0);
		const accounts = await DB().prepare('SELECT user_id, is_active, subject_properties FROM account_sessions WHERE user_id = ?').bind(body.userId).all<Record<string, any>>();
		expect(accounts.results).toHaveLength(1);
		expect(JSON.parse(accounts.results![0].subject_properties)).toMatchObject({ id: body.userId, email: 'link@example.com', amr: ['otp'] });
		const events = audit.mock.calls.map((c) => c[0].eventType);
		expect(events).toEqual(expect.arrayContaining(['user.invite.opened', 'user.invite.accepted']));
	});

	it('a POST without the page\'s CSRF token, or from another origin, does nothing', async () => {
		const { body } = await invite();
		const link = linkOf(sent[0].html);
		const bare = await page('POST', link);
		expect(bare.status).toBe(403);
		expect(stateOf(await bare.text())).toBe('ready');
		const shown = await page('GET', link);
		const jar = cookiesOf(shown);
		const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(await shown.text())![1];
		expect((await page('POST', link, { cookie: cookieHeader(jar), form: { csrf: 'f'.repeat(64) } })).status).toBe(403);
		expect((await page('POST', link, { cookie: cookieHeader(jar), form: { csrf }, origin: 'https://evil.example.com' })).status).toBe(403);
		const row = await DB().prepare('SELECT token_used_at FROM user_invites WHERE id = ?').bind(body.inviteId).first<Record<string, any>>();
		expect(row!.token_used_at).toBeNull();
	});

	it('is single use under concurrency: of two clicks at once exactly one signs in', async () => {
		await invite();
		const link = linkOf(sent[0].html);
		const shown = await page('GET', link);
		const jar = cookiesOf(shown);
		const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(await shown.text())![1];
		const both = await Promise.all([0, 1].map(() => page('POST', link, { cookie: cookieHeader(jar), form: { csrf } })));
		const signedIn = both.filter((r) => r.headers.getSetCookie().some((c) => c.startsWith('__session=')));
		expect(signedIn).toHaveLength(1);
	});

	it('second click, no password or passkey yet: "Finish setting up", never "sign in"; it emails a fresh link (audited, limited)', async () => {
		const { body } = await invite({ email: 'second@example.com' });
		const link = linkOf(sent[0].html);
		await openAndSubmit(link);
		const again = await page('GET', link);
		const html = await again.text();
		expect(stateOf(html)).toBe('setup');
		expect(html).toContain('Finish setting up your account');
		expect(html).not.toMatch(/sign in/i);
		audit.mockClear();
		const { res } = await openAndSubmit(link);
		const sentPage = await res!.text();
		expect(stateOf(sentPage)).toBe('sent');
		expect(sent).toHaveLength(2);
		const fresh = linkOf(sent[1].html);
		// The new token reaches the inbox only, never the page
		expect(sentPage).not.toContain(fresh.split('/invite/')[1].split('?')[0]);
		expect(audit.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining([expect.objectContaining({ eventType: 'user.invite.resent', metadata: expect.objectContaining({ by: 'invitee', emailSent: true }) })]));
		// The fresh link signs in again (the inbox is still the only way in)
		expect(stateOf(await (await page('GET', fresh)).text())).toBe('ready');
		const { res: second } = await openAndSubmit(fresh);
		expect(second!.headers.getSetCookie().some((c) => c.startsWith('__session='))).toBe(true);
		// Within 5 minutes of a send, asking again only says "we just sent one"
		const { res: soon } = await openAndSubmit(fresh);
		expect(stateOf(await soon!.text())).toBe('cooldown');
		expect(sent).toHaveLength(2);
		const row = await DB().prepare('SELECT send_count FROM user_invites WHERE id = ?').bind(body.inviteId).first<Record<string, any>>();
		expect(row!.send_count).toBe(2);
	});

	it('an expired link that was never used also offers "Finish setting up"', async () => {
		const { body } = await invite();
		const link = linkOf(sent[0].html);
		await DB().prepare('UPDATE user_invites SET expires_at = 1 WHERE id = ?').bind(body.inviteId).run();
		const res = await page('GET', link);
		expect(stateOf(await res.text())).toBe('setup');
		const list = await call('GET', `/provisioning/invites?ids=${body.inviteId}`);
		expect(list.json.invites[0].status).toBe('expired');
	});

	it('an account that is already set up (password) gets "You\'re already set up" + Sign in', async () => {
		await invite({ email: 'setup-done@example.com', continueUrl: 'http://localhost:3000/api/auth/login?prompt=login' });
		const link = linkOf(sent[0].html);
		await openAndSubmit(link);
		await Storage.set(authStorage(E()), ['email', 'setup-done@example.com', 'password'], { hash: 'x' });
		const html = await (await page('GET', link)).text();
		expect(stateOf(html)).toBe('active');
		expect(html).toContain('href="http://localhost:3000/api/auth/login"');
		// and no new link can be asked for
		expect(html).not.toContain('/send');
	});

	it('a link opened in the browser that is signed in as the invited account just continues', async () => {
		await invite();
		const link = linkOf(sent[0].html);
		const { jar } = await openAndSubmit(link);
		const html = await (await page('GET', link, { cookie: cookieHeader(jar) })).text();
		expect(stateOf(html)).toBe('signed-in');
	});

	it('other accounts signed in change nothing: no extra step, the invited account joins them and becomes the active one', async () => {
		await invite({ email: 'first@example.com' });
		const { jar } = await openAndSubmit(linkOf(sent[0].html));
		const first = await DB().prepare(`SELECT id FROM users WHERE email = 'first@example.com'`).first<{ id: string }>();
		const before = await DB().prepare('SELECT browser_session_id, authenticated_at, expires_at FROM account_sessions WHERE user_id = ?').bind(first!.id).first<Record<string, any>>();
		const firstBefore = await DB().prepare('SELECT metadata FROM users WHERE id = ?').bind(first!.id).first<{ metadata: string }>();
		await invite({ email: 'invitee@example.com' });
		const link = linkOf(sent[1].html);
		const shown = await page('GET', link, { cookie: cookieHeader(jar) });
		const html = await shown.text();
		// The same page as for a signed-out browser: no interstitial, no warning, no mention of the other account
		expect(stateOf(html)).toBe('ready');
		expect(html).not.toContain('first@example.com');
		const { res } = await openAndSubmit(link, jar);
		expect(res!.status).toBe(200);
		expect(await res!.text()).toContain('data-page="passkey"');
		const invited = await DB().prepare(`SELECT id FROM users WHERE email = 'invitee@example.com'`).first<{ id: string }>();
		// One browser session holding both; the invited account is the active one
		const browser = await DB().prepare('SELECT active_user_id FROM browser_sessions WHERE id = ?').bind(before!.browser_session_id).first<{ active_user_id: string }>();
		expect(browser!.active_user_id).toBe(invited!.id);
		const rows = await DB().prepare('SELECT user_id, is_active, authenticated_at, expires_at FROM account_sessions WHERE browser_session_id = ? ORDER BY user_id').bind(before!.browser_session_id).all<Record<string, any>>();
		expect(rows.results!.map((r) => [r.user_id, r.is_active])).toEqual(
			[[first!.id, 0], [invited!.id, 1]].sort((x, y) => String(x[0]).localeCompare(String(y[0])))
		);
		// The other account is still signed in, its sign-in untouched
		const other = rows.results!.find((r) => r.user_id === first!.id)!;
		expect(other.authenticated_at).toBe(before!.authenticated_at);
		expect(other.expires_at).toBe(before!.expires_at);
		// The invite went to the invited account only: the other one's account is as it was
		const firstUser = await DB().prepare('SELECT status, metadata FROM users WHERE id = ?').bind(first!.id).first<{ status: string; metadata: string }>();
		expect(JSON.parse(firstUser!.metadata).invite_accepted_at).toBe(JSON.parse(firstBefore!.metadata).invite_accepted_at);
	});

	it('a browser whose session is full gets a clean new session for the invited account', async () => {
		const jar: Record<string, string> = {};
		for (let i = 0; i < 3; i++) {
			await invite({ email: `full-${i}@example.com` });
			await openAndSubmit(linkOf(sent[sent.length - 1].html), jar);
		}
		const oldSession = jar.__session;
		await invite({ email: 'fourth@example.com' });
		const { res } = await openAndSubmit(linkOf(sent[sent.length - 1].html), jar);
		expect(res!.status).toBe(200);
		expect(jar.__session).not.toBe(oldSession);
		const fourth = await DB().prepare(`SELECT id FROM users WHERE email = 'fourth@example.com'`).first<{ id: string }>();
		const row = await DB().prepare('SELECT browser_session_id FROM account_sessions WHERE user_id = ?').bind(fourth!.id).first<{ browser_session_id: string }>();
		const count = await DB().prepare('SELECT COUNT(*) AS n FROM account_sessions WHERE browser_session_id = ?').bind(row!.browser_session_id).first<{ n: number }>();
		expect(count!.n).toBe(1);
	});

	it('a revoked invite says it was withdrawn; an unknown link says so too, without "sign in"', async () => {
		const { body } = await invite();
		const link = linkOf(sent[0].html);
		await call('POST', `/provisioning/invites/${body.inviteId}/revoke`, { actor: { id: 'usr_videosadmin' } });
		const gone = await page('GET', link);
		expect(gone.status).toBe(410);
		expect(stateOf(await gone.text())).toBe('withdrawn');
		const unknown = await page('GET', `https://auth.test/invite/${'0'.repeat(64)}`);
		expect(unknown.status).toBe(410);
		const html = await unknown.text();
		expect(stateOf(html)).toBe('unknown');
		expect(html).not.toMatch(/sign in/i);
	});

	it('speaks the invite\'s language unless ?lang= says otherwise', async () => {
		await invite({ locale: 'ar' });
		const link = linkOf(sent[0].html);
		const ar = await (await page('GET', link.replace('?lang=ar', ''))).text();
		expect(ar).toContain('حسابك جاهز');
		expect(ar).toContain('dir="rtl"');
		expect(await (await page('GET', `${link.split('?')[0]}?lang=en`)).text()).toContain('Your account is ready');
	});

	it('resend makes a new link (the old one stops working) and emails it again', async () => {
		const { body } = await invite();
		const old = linkOf(sent[0].html);
		const res = await call('POST', `/provisioning/invites/${body.inviteId}/resend`, { actor: { id: 'usr_videosadmin' } });
		expect(res.status).toBe(200);
		expect(res.json.invite.sendCount).toBe(2);
		expect((await page('GET', old)).status).toBe(410);
		expect(stateOf(await (await page('GET', linkOf(sent[1].html))).text())).toBe('ready');
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
		// The account is an admin soft delete like any other: Auth admin's Recently deleted lists it
		const deletion = await DB().prepare(`SELECT * FROM admin_deletions WHERE kind = 'user' AND item_id = ?`).bind(body.userId).first<Record<string, any>>();
		expect(deletion).toMatchObject({ label: 'revoked@example.com', deleted_by: 'usr_videosadmin', reason: 'Invite revoked: Wrong address' });
		expect(JSON.parse(deletion!.snapshot)).toEqual({ status: 'invited', email: 'revoked@example.com' });
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
		expect(await DB().prepare(`SELECT 1 FROM admin_deletions WHERE kind = 'user' AND item_id = ?`).bind(body.userId).first()).toBeNull();

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
	// Rendering details (one language, channels, escaping, text parity): email-templates.test.ts
	const data = { email: 'x@example.com', name: '<b>Ali</b>', link: 'https://auth.test/invite/abc', expiresAt: Date.UTC(2026, 10, 24), note: null, locale: 'en' as const };
	it('is in the invite\'s one language and escapes what the admin typed', () => {
		const html = inviteEmailHtml(data);
		expect(html).toContain('lang="en"');
		expect(html).not.toContain('dir="rtl"');
		expect(html).toContain('&lt;b&gt;Ali&lt;/b&gt;');
		expect(inviteEmailHtml({ ...data, locale: 'ar' })).not.toContain('dir="ltr" lang="en"');
		expect(inviteEmailText(data)).toContain('https://auth.test/invite/abc');
		expect(inviteEmailSubject('en')).toBe("You're invited to Al Ummah Now");
		expect(inviteEmailSubject('ar')).toBe('دعوة للانضمام إلى الأمة الآن');
	});
});
