/**
 * The after-sign-in passkey card's language switch (AUDIT-2, Auth #442 round 7; wiki E10 "UNIFY":
 * one header on every sign-in page). The card answers the issuer's POST and continues to the app's
 * redirect with the authorization code, which must never go into a link. So the header's switch
 * posts the card's signed token to /passkeys/card/language, which shows the same card in the other
 * language, and the switch's plain href (no script) is that code-free path.
 */
import { describe, expect, it } from 'vitest';
import { afterSignInCard } from '../passkeys/card';
import { CARD_LANGUAGE_FORM_ID, CARD_LANGUAGE_PATH, handleCardLanguage, readCardLanguage, signCardLanguage } from '../passkeys/card-language';
import { copyFor } from '../passkeys/pages';
import { withSignInChrome } from '../router';

const ENV = { SESSION_SECRET: 'a'.repeat(64), PASSKEY_PROMPT: 'on' };
const ORIGIN = 'https://auth.example';
const REDIRECT = 'https://profile.example/callback?code=SECRET-CODE&state=STATE-1';
const CLAIMS = { u: 'user-1', m: 'pk-maryam.siddiqui@mail.alummahnow.net', s: false, c: REDIRECT };

/** No passkeys, never dismissed */
const db = { prepare: () => ({ bind: () => ({ first: async () => null }) }) } as unknown as D1Database;

const card = (locale: 'en' | 'ar' = 'en') =>
	afterSignInCard({
		db,
		env: ENV,
		provider: 'password',
		userId: CLAIMS.u,
		email: CLAIMS.m,
		roles: ['user'],
		locale,
		redirect: new Response(null, { status: 302, headers: { Location: REDIRECT, 'Set-Cookie': '__session=s; Path=/; HttpOnly' } }),
		emailAvailable: true,
	});

const hrefs = (html: string) => [...html.matchAll(/\shref="([^"]*)"/g)].map((m) => m[1]);
const langLink = (html: string) => /<a class="aun-lang" href="([^"]*)"/.exec(html)?.[1];
const post = (body: Record<string, string>, headers: Record<string, string> = { Origin: ORIGIN }) =>
	new Request(ORIGIN + CARD_LANGUAGE_PATH, { method: 'POST', headers, body: new URLSearchParams(body) });

describe('after-sign-in card: the header language switch (one header everywhere)', () => {
	it('the card names a code-free path as its twin and carries the signed token in a hidden form', async () => {
		const res = (await card())!;
		expect(res.headers.get('Content-Location')).toBe(CARD_LANGUAGE_PATH);
		expect(res.headers.get('Set-Cookie')).toContain('__session=');
		const html = await res.text();
		expect(html).toContain(`<form id="${CARD_LANGUAGE_FORM_ID}" method="post" action="${CARD_LANGUAGE_PATH}" hidden>`);
		expect(html).toContain('<input type="hidden" name="lang" value="ar" />');
		expect(html).toContain("closest('a.aun-lang')");
	});

	it('with the shared header, the language link is the code-free path, and no link holds the code', async () => {
		const res = (await card())!;
		const page = await (await withSignInChrome(res, new URL(`${ORIGIN}/password/authorize`), {})).text();
		expect(page).toContain('class="aun-header');
		expect(langLink(page)).toBe(`${CARD_LANGUAGE_PATH}?lang=ar`);
		for (const href of hrefs(page)) {
			expect(href).not.toContain('SECRET-CODE');
			expect(href).not.toContain('STATE-1');
		}
	});

	it.each([['en', 'ar'], ['ar', 'en']] as const)('posting the token shows the same card in the other language (%s → %s)', async (from, to) => {
		const token = await signCardLanguage(ENV, CLAIMS);
		const res = await handleCardLanguage(post({ token, lang: to }), ENV);
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Location')).toBe(CARD_LANGUAGE_PATH);
		const chrome = res.clone();
		const html = await res.text();
		expect(html).toContain(`lang="${to}"`);
		expect(html).toContain(copyFor(to).add);
		// still continues to the app's redirect (inside the page's script, as before), and can switch back
		expect(html).toContain(JSON.stringify(REDIRECT).slice(1, -1));
		expect(html).toContain(`<input type="hidden" name="lang" value="${from}" />`);
		const page = await (await withSignInChrome(chrome, new URL(ORIGIN + CARD_LANGUAGE_PATH), {})).text();
		expect(langLink(page)).toBe(`${CARD_LANGUAGE_PATH}?lang=${from}`);
	});

	it('a forged, altered or expired token shows "expired", never a page for someone else\'s redirect', async () => {
		const token = await signCardLanguage(ENV, CLAIMS);
		const [body, sig] = token.split('.');
		const forged = await signCardLanguage({ SESSION_SECRET: 'b'.repeat(64) }, { ...CLAIMS, c: 'https://evil.example/' });
		const altered = `${Buffer.from(JSON.stringify({ ...CLAIMS, c: 'https://evil.example/', x: Date.now() + 60_000 })).toString('base64url')}.${sig}`;
		const expired = await signCardLanguage(ENV, CLAIMS, Date.now() - 11 * 60 * 1000);
		for (const bad of [forged, altered, expired, body, '', 'x.y.z']) {
			const res = await handleCardLanguage(post({ token: bad, lang: 'ar' }), ENV);
			expect(res.status).toBe(400);
			const html = await res.text();
			expect(html).toContain('انتهت صلاحية هذه الصفحة');
			expect(html).not.toContain('evil.example');
		}
		expect(await readCardLanguage(ENV, token)).toMatchObject(CLAIMS);
		expect(await readCardLanguage(ENV, expired)).toBeNull();
	});

	it('without script the link (GET) goes to the setup page in that language; the code is never involved', async () => {
		const res = await handleCardLanguage(new Request(`${ORIGIN}${CARD_LANGUAGE_PATH}?lang=ar`), ENV);
		expect(res.status).toBe(303);
		expect(res.headers.get('Location')).toBe('/passkeys/setup?lang=ar');
	});
});
