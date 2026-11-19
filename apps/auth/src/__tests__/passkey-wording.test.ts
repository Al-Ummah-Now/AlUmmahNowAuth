import { describe, expect, it } from 'vitest';
import { copyFor, renderAddPasskeyPage } from '../passkeys/pages';
import { registrationExpired, signRegistration } from '../passkeys/routes';

const env = { SESSION_SECRET: 'a'.repeat(64) } as never;

describe('add-a-passkey failure messages say what went wrong and what to do', () => {
	it.each(['en', 'ar'] as const)('has failed, cancelled, network and expired copy (%s)', async (locale) => {
		const t = copyFor(locale);
		for (const key of ['failed', 'cancelled', 'network', 'expired'] as const) expect(t[key].length).toBeGreaterThan(30);
		const html = await (
			await renderAddPasskeyPage({ locale, mode: 'setup', staff: false, needsCode: false, email: 'a@e2e.alummahnow.net', continueUrl: 'https://profile.auth.alummahnow.net/#passkeys', autoContinue: true, lang: locale })
		).text();
		// The page script maps the server's `expired` and a dropped connection to their own lines
		expect(html).toContain(JSON.stringify(t.network).slice(1, 20));
		expect(html).toContain('"expired":');
		expect(html).toContain('n.__network=true');
	});
});

describe('registrationExpired', () => {
	it('is true for a genuine token whose 5 minutes are up', async () => {
		const token = await signRegistration(env, { u: 'u', s: 's', c: 'c', e: Date.now() - 1000 });
		expect(await registrationExpired(env, token)).toBe(true);
	});
	it('is false for a live token and for a forged one', async () => {
		const live = await signRegistration(env, { u: 'u', s: 's', c: 'c', e: Date.now() + 60_000 });
		expect(await registrationExpired(env, live)).toBe(false);
		const [body] = live.split('.');
		expect(await registrationExpired(env, `${body}.AAAA`)).toBe(false);
		expect(await registrationExpired(env, 'nope')).toBe(false);
	});
});
