/**
 * The invite card's title reads as a heading (AUDIT-2, Auth #442 round 9: "Your account is ready"
 * rendered at body size, unlike the passkey card's and the link-sent page's titles).
 */
import { describe, expect, it } from 'vitest';
import { renderInviteState } from '../invites/page';

const TITLE_RULE = '[data-page^="invite"] [data-component="title"] { font-size:1.25rem; font-weight:600;';

describe('invite page title', () => {
	for (const lang of ['en', 'ar'] as const) {
		it(`${lang}: the ready card's h1 gets the heading style`, async () => {
			const res = await renderInviteState(lang, {
				kind: 'ready',
				email: 'maryam.siddiqui@mail.alummahnow.net',
				action: '/invite/abc',
				csrf: 'c',
			});
			const body = await res.text();
			expect(body).toContain('<h1 data-component="title">');
			expect(body).toContain(TITLE_RULE);
		});
	}
});
