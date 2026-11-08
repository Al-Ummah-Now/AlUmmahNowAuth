/**
 * Single sign-out walks FRONTCHANNEL_LOGOUT_URLS, and /logout only returns to
 * an origin on that list. An app missing from an environment's list keeps its
 * session after a sign-out elsewhere, and its own sign-out cannot return to it
 * (stage sent videos.stage back to the profile app). A hop that does not
 * answer stops the whole chain, so an app is listed only once its deployed
 * front-channel route exists in that environment.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../../..');
const prodStage = JSON.parse(readFileSync(resolve(ROOT, 'apps/auth/wrangler.json'), 'utf8'));
const qa = JSON.parse(readFileSync(resolve(ROOT, 'apps/auth/wrangler.qa.json'), 'utf8'));
const CHAINS: Record<string, string> = {
	production: prodStage.env.production.vars.FRONTCHANNEL_LOGOUT_URLS,
	stage: prodStage.env.stage.vars.FRONTCHANNEL_LOGOUT_URLS,
	qa: qa.vars.FRONTCHANNEL_LOGOUT_URLS,
};
const SUB: Record<string, string> = { production: '', stage: '.stage', qa: '.qa' };

describe('single sign-out chain', () => {
	it.each(Object.keys(CHAINS))('%s reaches the videos site', (env) => {
		expect(CHAINS[env].split(',')).toContain(`https://videos${SUB[env]}.alummahnow.net/api/auth/logout`);
	});

	it('qa reaches the videos admin (admin-web front-channel, AlUmmahNow #295)', () => {
		expect(CHAINS.qa.split(',')).toContain('https://admin.qa.alummahnow.net/api/auth/logout');
	});

	it.each(Object.keys(CHAINS))('%s lists each app once, on its own environment, over https', (env) => {
		const list = CHAINS[env].split(',');
		expect(new Set(list).size).toBe(list.length);
		for (const u of list) {
			const url = new URL(u);
			expect(url.protocol).toBe('https:');
			expect(url.hostname.endsWith(`${SUB[env]}.alummahnow.net`)).toBe(true);
			if (env === 'production') expect(url.hostname).not.toMatch(/\.(qa|stage)\./);
		}
	});
});
