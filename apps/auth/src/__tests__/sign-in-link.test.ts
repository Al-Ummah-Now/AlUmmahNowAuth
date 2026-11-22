/**
 * Accounts with no sign-in method yet (sign-in-link/, docs/USER_INVITES.md "No sign-in method yet"),
 * end to end through the real Worker: the sign-in page's two options, "Email me a sign-in link"
 * (the invite's single-use link), "Add a password" (register, setup=1), and the passkey card after
 * an invite sign-in (the note, "Continue without a passkey", failures audited, never a dismiss).
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import '../test-setup';
import { Storage } from '@al-ummah-now/openauth/storage/storage';
import { ScryptHasher } from '@al-ummah-now/openauth/provider/password';
import { CloudflarePatchedStorage } from '../storage/cloudflare-patched';
import { registerTestClients, PROFILE } from './helpers/clients';
import { AuditEmitter } from '../audit-emitter';
import { claimInvitedAccount, InviteService } from '../invites/service';
import { coarseAgent, failureReason } from '../passkeys/agent';
import { copyFor } from '../passkeys/pages';
import { SIGN_IN_LINK_COPY } from '../invites/email';
import { safeBack, signInLinkCopy } from '../sign-in-link/routes';
import { PASSWORD_COPY } from '../ui/copy';

const sent = vi.hoisted(() => [] as Array<{ to: string; subject: string; html: string; text?: string }>);
vi.mock('../email', () => ({
	default: vi.fn(async (opts: { to: string; subject: string; html: string; text?: string }) => {
		sent.push(opts);
		return { success: true, emailId: `email-${sent.length}` };
	}),
}));

const { default: worker } = await import('../index');

const ORIGIN = 'http://localhost';
const PASSWORD = 'correct horse battery staple 1';
const E = () =>
	({
		...(env as unknown as Env),
		ENVIRONMENT: 'development',
		OPENAUTH_ISSUER: ORIGIN,
		RESEND_API_KEY: 're_test_key',
		SESSION_SECRET: 'ab'.repeat(32),
		PASSWORD_IP_LIMITER: undefined,
		PASSWORD_EMAIL_LIMITER: undefined,
	}) as unknown as Env;

const background: Promise<unknown>[] = [];
const ctx = () => ({ waitUntil: (p: Promise<unknown>) => void background.push(p.catch(() => {})), passThroughOnException: () => {} }) as unknown as ExecutionContext;
const settle = async () => {
	while (background.length) await Promise.all(background.splice(0));
};

class Browser {
	jar = new Map<string, string>();
	ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
	async fetch(path: string, init: RequestInit = {}) {
		const headers = new Headers(init.headers);
		headers.set('cookie', [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '));
		headers.set('Host', 'localhost');
		headers.set('User-Agent', this.ua);
		if (!headers.has('Accept')) headers.set('Accept', 'text/html');
		const url = path.startsWith('http') ? path : `${ORIGIN}${path.startsWith('/') ? '' : '/'}${path}`;
		const res = await worker.fetch(new Request(url, { ...init, headers, redirect: 'manual' }), E(), ctx());
		for (const c of res.headers.getSetCookie()) {
			const [pair] = c.split(';');
			const i = pair.indexOf('=');
			const value = pair.slice(i + 1);
			if (!value || /max-age=0/i.test(c)) this.jar.delete(pair.slice(0, i));
			else this.jar.set(pair.slice(0, i), value);
		}
		return res;
	}
	json(path: string, body: unknown, origin: string | null = ORIGIN) {
		return this.fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });
	}
	form(path: string, body: Record<string, string>) {
		return this.fetch(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN }, body: new URLSearchParams(body).toString() });
	}
	/** /authorize → the password sign-in page; returns its path (with auth_flow) and HTML */
	async signInPage(lang?: 'ar') {
		const start = await this.fetch(`/authorize?client_id=${PROFILE.id}&response_type=code&state=s&redirect_uri=${encodeURIComponent(PROFILE.redirect)}&provider=password${lang ? '&lang=ar' : ''}`);
		expect(start.status).toBe(302);
		const login = new URL(start.headers.get('location')!, ORIGIN);
		if (lang) login.searchParams.set('lang', lang);
		const res = await this.fetch(login.pathname + login.search);
		expect(res.status).toBe(200);
		return { path: login.pathname + login.search, html: await res.text() };
	}
}

const hex = () => crypto.randomUUID().replace(/-/g, '');
const unique = () => hex().slice(0, 8);
const storage = () => CloudflarePatchedStorage({ namespace: (env as unknown as Env).AUTH_STORAGE });

/** An invited account (no password, no passkey); `active` = it already accepted (signed in once, skipped the passkey). */
async function invitedAccount(opts: { active?: boolean; password?: boolean; locale?: 'en' | 'ar' } = {}) {
	const email = `no-method-${unique()}@example.com`;
	const service = new InviteService((env as unknown as Env).AUTH_DB);
	const { user, invite } = await service.create(
		{ inviteId: `inv_${hex()}`, userId: `usr_${hex()}`, email, name: 'Maryam Siddiqui', locale: opts.locale ?? 'en' },
		{ userId: 'usr_admin', email: 'admin@mail.alummahnow.net', clientId: 'videos-admin' }
	);
	if (opts.active) await claimInvitedAccount((env as unknown as Env).AUTH_DB, 'default', user.id);
	if (opts.password) await Storage.set(storage(), ['email', email, 'password'], await ScryptHasher().hash(PASSWORD));
	return { email, userId: user.id, inviteId: invite.id };
}

const csrfOf = (html: string) => /name="csrf" value="([0-9a-f]{64})"/.exec(html)?.[1] ?? '';
const loginMode = (html: string) => /<form data-component="form" method="post" data-aun-login( data-aun-mode="no-password")?>/.exec(html)?.[1] ? 'no-password' : 'password';
const optionsBlock = (html: string) => /<div data-component="form" data-aun-no-password([^>]*)>/.exec(html)?.[1];
const linkIn = (email: { html: string }) => /href="(http:\/\/localhost\/invite\/[0-9a-f]{64}[^"]*)"/.exec(email.html)?.[1]?.replace(/&amp;/g, '&');

let emits: ReturnType<typeof vi.spyOn>;
const events = (type: string) => emits.mock.calls.map((c) => c[0] as { eventType: string; userId?: string; metadata?: Record<string, unknown> }).filter((e) => e.eventType === type);

beforeAll(async () => {
	await registerTestClients();
});

beforeEach(() => {
	sent.length = 0;
	emits?.mockRestore();
	emits = vi.spyOn(AuditEmitter.prototype, 'emit');
});

describe('POST /sign-in/method', () => {
	it('says only whether the email has a password: an unknown email and a no-method account answer the same', async () => {
		const b = new Browser();
		const withPassword = await invitedAccount({ active: true, password: true });
		const noMethod = await invitedAccount({ active: true });
		const invited = await invitedAccount();
		const answer = async (email: string) => {
			const res = await b.json('/sign-in/method', { email });
			expect(res.status).toBe(200);
			return res.text();
		};
		expect(JSON.parse(await answer(withPassword.email))).toEqual({ password: true });
		const unknown = await answer(`nobody-${unique()}@example.com`);
		expect(JSON.parse(unknown)).toEqual({ password: false });
		expect(await answer(noMethod.email)).toBe(unknown);
		expect(await answer(invited.email)).toBe(unknown);
		// Case and spaces don't change the answer
		expect(JSON.parse(await answer(`  ${withPassword.email.toUpperCase()} `))).toEqual({ password: true });
	});

	it('refuses another origin, a GET, and an address that is not one', async () => {
		const b = new Browser();
		expect((await b.json('/sign-in/method', { email: 'a@example.com' }, 'https://evil.example')).status).toBe(403);
		expect((await b.fetch('/sign-in/method')).status).toBe(405);
		expect((await b.json('/sign-in/method', { email: 'not-an-email' })).status).toBe(400);
	});

	it('is rate limited per IP (PASSWORD_IP_LIMITER)', async () => {
		const limited = { limit: vi.fn(async () => ({ success: false })) };
		const req = new Request(`${ORIGIN}/sign-in/method`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, Host: 'localhost' }, body: JSON.stringify({ email: 'a@example.com' }) });
		const res = await worker.fetch(req, { ...E(), PASSWORD_IP_LIMITER: limited } as unknown as Env, ctx());
		expect(res.status).toBe(429);
		expect(limited.limit).toHaveBeenCalledWith({ key: expect.stringContaining('signin:method:ip:') });
	});
});

describe('the sign-in page', () => {
	it.each([undefined, 'ar'] as const)('carries the two options, hidden until the email has no password (%s)', async (lang) => {
		const b = new Browser();
		const { html } = await b.signInPage(lang);
		const t = signInLinkCopy(lang ?? 'en');
		expect(optionsBlock(html)).toContain('hidden');
		expect(html).toContain('data-aun-login');
		expect(html).toContain(t.link);
		expect(html).toContain(t.addPassword);
		expect(html).toContain('action="/sign-in/link"');
		expect(html).toMatch(/href="register\?auth_flow=[^"]*&amp;setup=1/);
		expect(b.jar.get('signin_csrf')).toBe(csrfOf(html));
		// The script asks /sign-in/method and never posts the password form for an email without one
		expect(html).toContain('"method":"/sign-in/method"');
	});

	it('without JavaScript: signing in with an email that has no password shows the options at once, never "wrong password"', async () => {
		const b = new Browser();
		const { email } = await invitedAccount({ active: true });
		const { path } = await b.signInPage();
		const res = await b.form(path, { email, password: 'anything at all' });
		expect(res.status).toBe(401); // this POST did not sign in; only the page is different
		const html = await res.text();
		expect(optionsBlock(html)).not.toContain('hidden');
		expect(loginMode(html)).toBe('no-password');
		expect(html).toContain(`name="email" value="${email}"`);
	});

	it('an unknown email gets the very same options (nothing says whether an account exists)', async () => {
		const b = new Browser();
		const { path } = await b.signInPage();
		const res = await b.form(path, { email: `nobody-${unique()}@example.com`, password: 'anything at all' });
		expect(res.status).toBe(401);
		expect(loginMode(await res.text())).toBe('no-password');
	});

	it('a wrong password for an account that has one is the normal error, options hidden', async () => {
		const b = new Browser();
		const { email } = await invitedAccount({ active: true, password: true });
		const { path } = await b.signInPage();
		const res = await b.form(path, { email, password: 'wrong password here' });
		expect(res.status).toBe(401);
		const html = await res.text();
		expect(loginMode(html)).toBe('password');
		expect(optionsBlock(html)).toContain('hidden');
	});
});

describe('"Email me a sign-in link"', () => {
	async function ask(b: Browser, email: string, lang: 'en' | 'ar' = 'en') {
		const { path, html } = await b.signInPage(lang === 'ar' ? 'ar' : undefined);
		const res = await b.form('/sign-in/link', { csrf: csrfOf(html), email, lang, back: path });
		await settle();
		return { res, html: await res.text(), path };
	}

	it('emails a no-method account the single-use link, in its own sign-in email; the link signs in and offers the passkey card again', async () => {
		const b = new Browser();
		const { email, userId } = await invitedAccount({ active: true });
		const { res, html, path } = await ask(b, email);
		expect(res.status).toBe(200);
		expect(html).toContain('data-state="sent"');
		expect(html).toContain(`<bdi dir="ltr">${email}</bdi>`);
		expect(html).toContain(`href="${path.replace(/&/g, '&amp;')}"`);
		expect(sent).toHaveLength(1);
		expect(sent[0].to).toBe(email);
		expect(sent[0].subject).toBe(SIGN_IN_LINK_COPY.en.subject);
		expect(events('user.invite.resent')[0]?.metadata).toMatchObject({ by: 'sign_in_page', emailSent: true });

		const link = linkIn(sent[0])!;
		const shown = await b.fetch(link);
		const form = await shown.text();
		const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(form)![1];
		const action = /<form[^>]*action="([^"]+)"/.exec(form)![1].replace(/&amp;/g, '&');
		const card = await b.form(action, { csrf });
		expect(card.status).toBe(200);
		const cardHtml = await card.text();
		expect(cardHtml).toContain('data-page="passkey"');
		expect(cardHtml).toContain(copyFor('en').noPasskeyYet);
		expect(b.jar.get('__session')).toBeTruthy();
		// Single use: the same link again does not sign in
		const again = await new Browser().fetch(link);
		expect(await again.text()).not.toContain('data-state="ready"');
		expect(userId).toMatch(/^usr_/);
	});

	it('speaks Arabic when asked from the Arabic page', async () => {
		const b = new Browser();
		const { email } = await invitedAccount({ active: true, locale: 'en' });
		const { html } = await ask(b, email, 'ar');
		expect(html).toContain(signInLinkCopy('ar').sentTitle);
		expect(sent[0].subject).toBe(SIGN_IN_LINK_COPY.ar.subject);
		expect(linkIn(sent[0])).toContain('?lang=ar');
	});

	it('answers the same page for an unknown email and an account with a password, and sends nothing', async () => {
		const withPassword = await invitedAccount({ active: true, password: true });
		const a = await ask(new Browser(), withPassword.email);
		const unknownEmail = `nobody-${unique()}@example.com`;
		const b = await ask(new Browser(), unknownEmail);
		expect(a.res.status).toBe(200);
		expect(b.res.status).toBe(200);
		const strip = (html: string, email: string) => html.split(email).join('EMAIL').replace(/auth_flow(?:=|%3D)[^"&%]+/g, '').replace(/[0-9a-f]{64}/g, '');
		expect(strip(a.html, withPassword.email)).toBe(strip(b.html, unknownEmail));
		expect(sent).toHaveLength(0);
	});

	it('a second ask within minutes sends no second email (the invite resend cooldown)', async () => {
		const { email } = await invitedAccount({ active: true });
		await ask(new Browser(), email);
		await ask(new Browser(), email);
		expect(sent).toHaveLength(1);
	});

	it('needs the page\'s CSRF token, and is rate limited per IP and per email (SEND_CODE_LIMITER)', async () => {
		const b = new Browser();
		const { path } = await b.signInPage();
		expect((await b.form('/sign-in/link', { csrf: 'f'.repeat(64), email: 'a@example.com', lang: 'en', back: path })).status).toBe(403);

		const keys: string[] = [];
		const limiter = { limit: vi.fn(async ({ key }: { key: string }) => (keys.push(key), { success: !key.includes(':email:') })) };
		const { html } = await b.signInPage();
		const req = new Request(`${ORIGIN}/sign-in/link`, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN, Host: 'localhost', cookie: `signin_csrf=${csrfOf(html)}` },
			body: new URLSearchParams({ csrf: csrfOf(html), email: 'a@example.com', lang: 'en', back: path }).toString(),
		});
		const res = await worker.fetch(req, { ...E(), SEND_CODE_LIMITER: limiter } as unknown as Env, ctx());
		expect(res.status).toBe(429);
		expect(keys.some((k) => k.startsWith('signin:link:ip:'))).toBe(true);
		expect(keys.some((k) => k.startsWith('signin:link:email:') && !k.includes('a@example.com'))).toBe(true);
	});

	it('"Back to sign in" only ever goes to our own sign-in page', () => {
		expect(safeBack('/password/authorize?auth_flow=x')).toBe('/password/authorize?auth_flow=x');
		expect(safeBack('/authorize?client_id=x')).toBe('/authorize?client_id=x');
		for (const bad of ['https://evil.example/', '//evil.example/password/authorize', '/admin', '/\\evil', 42]) expect(safeBack(bad)).toBe('/');
	});
});

describe('"Add a password"', () => {
	it.each([undefined, 'ar'] as const)('register with setup=1 is titled "Add a password", explains the code, and prefills the email (%s)', async (lang) => {
		const b = new Browser();
		const { html } = await b.signInPage(lang);
		const href = /href="(register\?[^"]*setup=1[^"]*)"/.exec(html)![1].replace(/&amp;/g, '&');
		const res = await b.fetch(`/password/${href}`);
		expect(res.status).toBe(200);
		const page = await res.text();
		const t = signInLinkCopy(lang ?? 'en');
		expect(page).toContain(`data-testid="add-password-title">${t.setupTitle}</h1>`);
		expect(page).toContain(t.setupText);
		expect(page).toContain('aun.setupEmail');
	});

	it('plain register is unchanged', async () => {
		const b = new Browser();
		const { html } = await b.signInPage();
		const href = /href="(register\?auth_flow=[^"]*)"/.exec(html)![1].replace(/&amp;/g, '&');
		expect(await (await b.fetch(`/password/${href.replace('&setup=1', '')}`)).text()).not.toContain('add-password-title');
	});
});

describe('the passkey card after an invite sign-in', () => {
	async function signedInFromLink() {
		const b = new Browser();
		const { email, userId } = await invitedAccount({ active: true });
		const { html, path } = await b.signInPage();
		await b.form('/sign-in/link', { csrf: csrfOf(html), email, lang: 'en', back: path });
		await settle();
		const shown = await (await b.fetch(linkIn(sent[sent.length - 1])!)).text();
		const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(shown)![1];
		const action = /<form[^>]*action="([^"]+)"/.exec(shown)![1].replace(/&amp;/g, '&');
		const card = await (await b.form(action, { csrf })).text();
		return { b, card, userId };
	}

	it('carries the "No passkey yet" note (hidden until a failure or Skip) and "Continue without a passkey" for the second failure', async () => {
		const { card } = await signedInFromLink();
		const t = copyFor('en');
		expect(card).toMatch(new RegExp(`data-slot="note" hidden>${t.noPasskeyYet.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
		expect(card).toContain(`"continueWithout":${JSON.stringify(t.continueWithout)}`);
		expect(card).toContain('"note":true');
		// Two failures switch the second button; a dismiss only when nothing failed
		expect(card).toContain('if(fails>=2&&skip)skip.textContent=C.t.continueWithout');
		expect(card).toContain("var dismiss=C.mode==='card'&&!C.staff&&fails===0");
		expect(card).toContain("post('/passkeys/prompt/failed',{reason:reason})");
	});

	it('Arabic copy follows the Arabic rules: «،» and the guillemets around the place in the account', () => {
		const t = copyFor('ar');
		expect(t.noPasskeyYet).toContain('في المرة القادمة،');
		// The place in the account never breaks across lines
		expect(t.noPasskeyYet).toContain('«الحساب\u00a0←\u00a0مفاتيح\u00a0المرور»');
		expect(copyFor('en').noPasskeyYet).toContain('Account\u00a0→\u00a0Passkeys');
		expect(signInLinkCopy('en').noPassword).toContain('sign\u00a0in:');
		expect(signInLinkCopy('ar').noPassword).toContain('تسجيل\u00a0الدخول:');
		expect(t.noPasskeyYet).not.toMatch(/[,0-9]/);
		expect(t.continueWithout).toBe('المتابعة دون مفتاح مرور');
	});

	it('a failure is audited with its reason and a coarse browser/OS, and never snoozes the card', async () => {
		const { b, userId } = await signedInFromLink();
		const res = await b.json('/passkeys/prompt/failed', { reason: 'cancelled' });
		expect(res.status).toBe(204);
		await settle();
		const [event] = events('passkey.add_failed');
		expect(event.userId).toBe(userId);
		expect(event.metadata).toEqual({ reason: 'cancelled', browser: 'Safari', os: 'iOS' });
		const row = await (env as unknown as Env).AUTH_DB.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first<Record<string, unknown>>();
		expect(row?.passkey_prompt_dismissed_at ?? null).toBeNull();
	});

	it('an unknown reason is recorded as "failed"; signed out or from another origin it is refused', async () => {
		const { b } = await signedInFromLink();
		await b.json('/passkeys/prompt/failed', { reason: '<script>' });
		await settle();
		expect(events('passkey.add_failed')[0].metadata?.reason).toBe('failed');
		expect((await new Browser().json('/passkeys/prompt/failed', { reason: 'failed' })).status).toBe(401);
		expect((await b.json('/passkeys/prompt/failed', { reason: 'failed' }, 'https://evil.example')).status).toBe(403);
	});
});

describe('coarseAgent', () => {
	it.each([
		['Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1', 'Safari', 'iOS'],
		['Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0 Mobile/15E148 Safari/604.1', 'Chrome', 'iOS'],
		['Mozilla/5.0 (iPad; CPU OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1', 'Safari', 'iPadOS'],
		['Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36', 'Chrome', 'Android'],
		['Mozilla/5.0 (Linux; Android 15; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/27.0 Chrome/125.0 Mobile Safari/537.36', 'Samsung Internet', 'Android'],
		['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 Edg/131.0', 'Edge', 'Windows'],
		['Mozilla/5.0 (Macintosh; Intel Mac OS X 15.1; rv:133.0) Gecko/20100101 Firefox/133.0', 'Firefox', 'macOS'],
		['Mozilla/5.0 (X11; CrOS x86_64 16033.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36', 'Chrome', 'ChromeOS'],
		['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 OPR/115.0', 'Opera', 'Linux'],
		['curl/8.7.1', 'Other', 'Other'],
		[null, 'Other', 'Other'],
	])('%s → %s on %s', (ua, browser, os) => {
		expect(coarseAgent(ua)).toEqual({ browser, os });
	});
	it('keeps only the four reasons', () => {
		for (const r of ['failed', 'cancelled', 'network', 'expired']) expect(failureReason(r)).toBe(r);
		for (const r of ['exists', '', null, 7]) expect(failureReason(r)).toBe('failed');
	});
});

describe('one header on every sign-in page (wiki E10 "UNIFY")', () => {
	const langLink = (html: string) => /<a\b[^>]*href="([^"]+)"[^>]*hreflang="(?:ar|en)"/.exec(html)?.[1]?.replace(/&amp;/g, '&');
	const header = (html: string) => /class="aun-header/.test(html);

	it('"Check your inbox" has the header; its language switch shows the same page, without the email', async () => {
		const b = new Browser();
		const { email } = await invitedAccount({ active: true });
		const { html: page, path } = await b.signInPage();
		const res = await b.form('/sign-in/link', { csrf: csrfOf(page), email, lang: 'en', back: path });
		await settle();
		const html = await res.text();
		expect(header(html)).toBe(true);
		const twin = langLink(html)!;
		expect(twin).toMatch(/^\/sign-in\/link\?state=sent&back=[^&]+&lang=ar$/);
		expect(res.headers.get('Content-Location')).toBe(twin.replace('lang=ar', 'lang=en'));

		const ar = await b.fetch(twin);
		expect(ar.status).toBe(200);
		const arHtml = await ar.text();
		expect(header(arHtml)).toBe(true);
		expect(arHtml).toContain('lang="ar"');
		expect(arHtml).toContain(signInLinkCopy('ar').sentAny);
		expect(arHtml).not.toContain(email);
		// "Back to sign in" goes to the same sign-in page, now in Arabic
		const back = /<a data-component="button" data-color="ghost" href="([^"]+)"/.exec(arHtml)![1].replace(/&amp;/g, '&');
		expect(back.startsWith(path)).toBe(true);
		expect(new URL(back, ORIGIN).searchParams.get('lang')).toBe('ar');
		expect(sent).toHaveLength(1);
	});

	it('the GET views only display: busy and invalid stay themselves, anything else goes back, never off-site', async () => {
		const b = new Browser();
		const busy = await (await b.fetch('/sign-in/link?state=busy&back=%2Fpassword%2Fauthorize&lang=en')).text();
		expect(busy).toContain('data-state="busy"');
		expect(busy).toContain(signInLinkCopy('en').busyTitle);
		const invalid = await (await b.fetch('/sign-in/link?state=invalid&back=%2Fpassword%2Fauthorize&lang=ar')).text();
		expect(invalid).toContain('data-state="invalid"');
		expect(invalid).toContain(signInLinkCopy('ar').invalidTitle);
		const other = await b.fetch('/sign-in/link?state=anything&back=%2Fpassword%2Fauthorize');
		expect(other.status).toBe(303);
		expect(other.headers.get('Location')).toBe('/password/authorize');
		const evil = await b.fetch('/sign-in/link?state=sent&back=%2F%2Fevil.example');
		expect(await evil.text()).toContain('href="/"');
		expect(sent).toHaveLength(0);
	});

	it('the invite sign-in and its passkey card have the header; the card\'s language switch opens the setup page', async () => {
		const b = new Browser();
		const { email } = await invitedAccount({ active: true });
		const { html, path } = await b.signInPage();
		await b.form('/sign-in/link', { csrf: csrfOf(html), email, lang: 'en', back: path });
		await settle();
		const invite = await (await b.fetch(linkIn(sent[sent.length - 1])!)).text();
		expect(header(invite)).toBe(true);
		const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(invite)![1];
		const action = /<form[^>]*action="([^"]+)"/.exec(invite)![1].replace(/&amp;/g, '&');
		const card = await b.form(action, { csrf });
		const cardHtml = await card.text();
		expect(cardHtml).toContain('data-page="passkey"');
		expect(header(cardHtml)).toBe(true);
		const twin = new URL(langLink(cardHtml)!, ORIGIN);
		expect(twin.pathname).toBe('/passkeys/setup');
		expect(twin.searchParams.get('lang')).toBe('ar');
		expect(twin.searchParams.get('return_to')).toBeTruthy();
		// Signed in now: the setup page offers the passkey in Arabic
		const setup = await (await b.fetch(twin.pathname + twin.search)).text();
		expect(setup).toContain('data-page="passkey"');
		expect(setup).toContain(copyFor('ar').add);
		expect(header(setup)).toBe(true);
	});

	it('OpenAuth\'s links say "sign in" and use ’: "Don’t have an account?", "Back to sign in" / «العودة إلى تسجيل الدخول»', async () => {
		const b = new Browser();
		const { html, path } = await b.signInPage();
		expect(html).toContain('Don’t have an account?');
		expect(html).not.toContain("Don't have an account?");
		const { email } = await invitedAccount({ active: true, password: true });
		const change = `/password/change${new URL(path, ORIGIN).search}`;
		const code = await (await b.form(change, { action: 'code', email })).text();
		expect(code).toMatch(/Back to\s*<a data-component="link"[^>]*>sign in<\/a>/);
		expect(PASSWORD_COPY.ar.login.toLowerCase()).toBe('تسجيل الدخول');
		expect(PASSWORD_COPY.en.register_prompt).not.toMatch(/'/);
	});
});
