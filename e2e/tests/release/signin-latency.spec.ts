/**
 * Release regression: password sign-in latency budget (AlUmmahNow#804).
 *
 * 2026-11-11: a password POST took more than 15 s to commit its redirect; the
 * production post-promote check timed out and rolled the release back. Normally
 * the POST answers in about a second. This spec signs one fresh account in ten
 * times, each in a clean browser session, and measures the click on "Continue"
 * until the browser is back on the profile app (POST → redirect chain → app
 * callback, which exchanges the code at /token). It fails when the 95th
 * percentile is over the budget.
 *
 * Every run prints its time and the auth server's Server-Timing for the POST,
 * so a failure names the slow stage (guard, issuer, onsuccess-*, d1, kv).
 *
 * Runs against QA on PRs and against stage in the release workflow.
 */
import { test, expect, type Page, type Response } from '@playwright/test';
import { register } from '../../fixtures/auth';
import { TEST_URLS, generateTestEmail } from '../../utils/test-data';
import { fillSecret } from '../../utils/secret-input';
import { TEST_PASSWORD } from '../../utils/test-credentials';

// Types the test password: no traces (see e2e/utils/secret-input.ts)
test.use({ trace: 'off' });

const RUNS = 10;
const BUDGET_MS = 5000;
/** PASSWORD_EMAIL_LIMITER allows 10 password POSTs per email per minute (registration counts too) */
const MIN_GAP_MS = 6500;

/** Nearest-rank percentile. */
function percentile(values: number[], p: number): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

async function signInOnce(page: Page, email: string): Promise<{ ms: number; serverTiming: string }> {
	await page.goto(TEST_URLS.profileApp);
	await expect(page).toHaveURL(new RegExp(TEST_URLS.authServer), { timeout: 15000 });
	await page.fill('input[type="email"]', email);
	await fillSecret(page.locator('input[type="password"]').first(), TEST_PASSWORD);

	let serverTiming = '';
	const onResponse = (res: Response) => {
		const req = res.request();
		if (req.method() === 'POST' && new URL(req.url()).pathname === '/password/authorize') {
			serverTiming = res.headers()['server-timing'] ?? '';
		}
	};
	page.on('response', onResponse);
	const profileOrigin = new URL(TEST_URLS.profileApp).origin;
	const started = Date.now();
	await page.click('button:has-text("Continue")');
	// Back on the app: its callback has exchanged the code. 30 s so a slow run is measured, not just failed.
	await page.waitForURL((url) => url.origin === profileOrigin, { timeout: 30000, waitUntil: 'commit' });
	const ms = Date.now() - started;
	page.off('response', onResponse);
	return { ms, serverTiming };
}

test.describe('Release: password sign-in latency budget', () => {
	test.setTimeout(RUNS * (MIN_GAP_MS + 30000) + 60000);

	test(`password sign-in redirect p95 within ${BUDGET_MS} ms over ${RUNS} runs`, async ({ page, context }) => {
		const email = generateTestEmail('latency');
		await register(page, email);

		const times: number[] = [];
		for (let i = 0; i < RUNS; i++) {
			await context.clearCookies();
			const started = Date.now();
			const { ms, serverTiming } = await signInOnce(page, email);
			times.push(ms);
			console.log(`sign-in ${i + 1}/${RUNS}: ${ms} ms; auth POST Server-Timing: ${serverTiming || '(none)'}`);
			const wait = MIN_GAP_MS - (Date.now() - started);
			if (wait > 0 && i < RUNS - 1) await page.waitForTimeout(wait);
		}

		const p50 = percentile(times, 0.5);
		const p95 = percentile(times, 0.95);
		console.log(`password sign-in redirect: p50 ${p50} ms, p95 ${p95} ms, max ${Math.max(...times)} ms (budget p95 ${BUDGET_MS} ms)`);
		expect(p95, `p95 of ${RUNS} password sign-ins (${times.join(', ')} ms)`).toBeLessThanOrEqual(BUDGET_MS);
	});
});
