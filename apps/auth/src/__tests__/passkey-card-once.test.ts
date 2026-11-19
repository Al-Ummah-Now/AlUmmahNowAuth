import { describe, expect, it } from 'vitest';
import { renderAddPasskeyPage } from '../passkeys/pages';

/**
 * 2026-11-19 prod (iOS Safari): after "Passkey added" the card's timer opened the
 * app's one-time callback and the user tapped Continue while it loaded; the second
 * callback failed its state check. Every way off the page goes through one go()
 * that runs once, cancels the timer and disables the buttons.
 */
describe('add-a-passkey page leaves once', () => {
	it.each(['en', 'ar'] as const)('timer, Continue and Not now share a go() that runs once (%s)', async (locale) => {
		const res = await renderAddPasskeyPage({
			locale,
			mode: 'card',
			staff: false,
			needsCode: false,
			email: 'a@e2e.alummahnow.net',
			continueUrl: 'https://videos.alummahnow.net/api/callback?code=c&state=s',
			autoContinue: true,
			lang: locale,
		});
		const html = await res.text();
		expect(html).toContain('function go(){if(leaving)return;leaving=true;if(timer)clearTimeout(timer);');
		expect(html).toContain('[addBtn,skip,done].forEach(function(b){if(b)b.disabled=true;});');
		expect(html).toContain('timer=setTimeout(go,C.delay)');
		expect(html).toContain("done.addEventListener('click',go)");
		// window.location.assign is called only inside go()
		expect(html.match(/location\.assign\(/g)).toHaveLength(1);
	});
});
