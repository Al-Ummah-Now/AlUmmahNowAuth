/**
 * The passkey card asks the lantern street to redraw when it changes size (AUDIT-2, Auth #442
 * round 7: after a failure the card showed its note, grew, re-centred and sat on a garland drawn
 * for its old size). The vendored street redraws on an <html> class change, so the card flips one.
 */
import { describe, expect, it } from 'vitest';
import { afterSignInCard } from '../passkeys/card';
import { STREET_RELAYOUT_SCRIPT } from '../passkeys/pages';

const db = { prepare: () => ({ bind: () => ({ first: async () => null }) }) } as unknown as D1Database;

/** Runs the script against a fake page; returns the ResizeObserver callback and the class flips seen */
function run() {
	const flips: string[] = [];
	let callback: ((entries: { contentRect: { height: number } }[]) => void) | undefined;
	const document = {
		querySelector: (sel: string) => (sel === '[data-page="passkey"]' ? {} : null),
		documentElement: { classList: { toggle: (c: string) => flips.push(c) } },
	};
	class ResizeObserver {
		constructor(cb: typeof callback) {
			callback = cb;
		}
		observe() {}
	}
	new Function('document', 'window', 'ResizeObserver', STREET_RELAYOUT_SCRIPT)(document, { ResizeObserver }, ResizeObserver);
	return { resize: (height: number) => callback!([{ contentRect: { height } }]), flips };
}

describe('passkey card: the lantern street follows the card', () => {
	it('every passkey card carries the script', async () => {
		const res = (await afterSignInCard({
			db,
			env: { SESSION_SECRET: 'a'.repeat(64), PASSKEY_PROMPT: 'on' },
			provider: 'password',
			userId: 'user-1',
			email: 'pk-maryam.siddiqui@mail.alummahnow.net',
			roles: ['user'],
			locale: 'ar',
			redirect: new Response(null, { status: 302, headers: { Location: 'https://profile.example/callback?code=c&state=s' } }),
			emailAvailable: true,
		}))!;
		expect(await res.text()).toContain(STREET_RELAYOUT_SCRIPT);
	});

	it('the first measurement draws nothing new; a size change makes the street redraw', () => {
		const { resize, flips } = run();
		resize(620);
		expect(flips).toEqual([]);
		resize(620);
		expect(flips).toEqual([]);
		resize(700); // the note appeared
		expect(flips).toEqual(['aun-relayout']);
		resize(760); // "Continue without a passkey" and the status
		expect(flips).toEqual(['aun-relayout', 'aun-relayout']);
	});
});
