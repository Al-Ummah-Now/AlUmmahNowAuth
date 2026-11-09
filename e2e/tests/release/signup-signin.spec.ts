/**
 * Release regression R1: sign-up → email code → sign-in → session, per client.
 *
 * Incident 2026-11-07: a client authorized with one redirect_uri and exchanged the
 * code with another; openauth's exact redirect_uri check rejected the exchange, so
 * every sign-in after registration ended on an error page. This spec drives the
 * full OAuth round trip for each client of this repo (profile, auth admin) and
 * fails on any error page or `error=` callback along the way. The web client is
 * covered by AlUmmahNow's apps/web/e2e/release/signup-signin.spec.ts.
 *
 * Runs against QA on PRs and against stage in the release workflow.
 */
import { test, expect, type Page } from '@playwright/test';
import { register, login, logout, getCurrentUser } from '../../fixtures/auth';
import { loginAdmin } from '../../fixtures/admin';
import { TEST_URLS, generateTestEmail } from '../../utils/test-data';

// Signs in with the test password / one-time codes (or sends test secrets in headers):
// traces would record them, so none for this file. See e2e/utils/secret-input.ts.
test.use({ trace: 'off' });

/** Records every main-frame navigation so a bounce through an error page is caught. */
function recordNavigations(page: Page): string[] {
  const urls: string[] = [];
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) urls.push(frame.url());
  });
  return urls;
}

function expectNoErrorHop(urls: string[]): void {
  const bad = urls.filter((u) => {
    const url = new URL(u);
    return url.searchParams.has('error') || /\/(auth\/)?error\b/.test(url.pathname);
  });
  expect(bad, `navigation went through an error: ${bad.join(' → ')}`).toEqual([]);
}

test.describe('Release R1: sign-up and sign-in per client', () => {
  test.setTimeout(120000);

  test('profile client: register, sign out, sign in again in a fresh session', async ({ page, context }) => {
    const email = generateTestEmail('r1-profile');
    const navigations = recordNavigations(page);

    // Sign-up: registration + email code + first OAuth callback
    await register(page, email);
    await expect(page.locator('#loggedInView')).toBeVisible();
    expect((await getCurrentUser(page)).email).toBe(email);

    // Sign-out, drop every cookie, and sign in again: a full authorize → code → token
    // exchange with no session to fall back on (the step that failed in the incident)
    await logout(page);
    await context.clearCookies();
    await login(page, email);
    await expect(page.locator('#loggedInView')).toBeVisible({ timeout: 15000 });
    expect(new URL(page.url()).origin).toBe(new URL(TEST_URLS.profileApp).origin);

    // The session survives a reload
    await page.reload();
    await expect(page.locator('#loggedInView')).toBeVisible({ timeout: 15000 });
    expect((await getCurrentUser(page)).email).toBe(email);

    expectNoErrorHop(navigations);
  });

  test('auth admin client: an admin signs in through the admin dashboard', async ({ page }) => {
    test.skip(!process.env.TEST_PROMOTE_SECRET, 'TEST_PROMOTE_SECRET not set: cannot create an admin user');
    const email = generateTestEmail('r1-admin');
    const navigations = recordNavigations(page);

    // loginAdmin registers the user, promotes it, clears cookies and signs in fresh
    await loginAdmin(page, email);
    expect(new URL(page.url()).origin).toBe(new URL(TEST_URLS.adminDashboard).origin);

    expectNoErrorHop(navigations);
  });
});
