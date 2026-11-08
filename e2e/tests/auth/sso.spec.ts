/**
 * Single sign-on and single sign-out across profile, admin and web.
 *
 * Before: every app showed the sign-in form again (the auth server only
 * reused its browser session for prompt=none; admin always sent
 * prompt=select_account), and logging out of one app left the others signed in.
 *
 *   1. sign in to profile
 *   2. open admin (and web, when E2E_WEB_URL is set): signed in, no form
 *   3. log out
 *   4. every app needs a sign-in again
 */
import { test, expect, type Page } from '@playwright/test';
import { register, logout } from '../../fixtures/auth';
import { TEST_URLS, generateTestEmail } from '../../utils/test-data';

const PASSWORD = 'TestPassword123!'; // same as fixtures/auth.ts
const WEB_URL = process.env.E2E_WEB_URL; // e.g. https://videos.qa.alummahnow.net
const WEB_SIGNED_IN_COOKIES = ['al_ummah_session', 'access_token'];

/** Every time the browser lands on the auth server's sign-in form. */
function trackSignInForm(page: Page): string[] {
  const visits: string[] = [];
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame() && new URL(frame.url()).pathname.startsWith('/password/')) visits.push(frame.url());
  });
  return visits;
}

/** Admin dashboard reached and signed in (sidebar "Users" link). */
async function openAdmin(page: Page) {
  await page.goto(TEST_URLS.adminDashboard);
  const users = page.locator('a:has-text("Users")');
  if (!(await users.isVisible().catch(() => false))) {
    await page.locator('a:has-text("Admin Sign In"), a:has-text("Sign In")').first().click();
  }
}

/** Clicks the web app's own Sign In (menu → Sign In), whatever its callback URL is. */
async function openWebSignIn(page: Page) {
  await page.goto(`${WEB_URL}/en`);
  await page.locator('button[aria-haspopup="menu"]').first().click();
  await page.locator('[role="menu"] form button[type="submit"]').first().click();
}

async function webSignedIn(page: Page) {
  const cookies = await page.context().cookies(WEB_URL!);
  return cookies.some((c) => WEB_SIGNED_IN_COOKIES.includes(c.name) && c.value);
}

test.describe('Single sign-on across profile, admin and web', () => {
  test.setTimeout(180000);

  test('one sign-in covers every app, and logging out signs out of all of them', async ({ page }) => {
    test.skip(!process.env.TEST_PROMOTE_SECRET, 'TEST_PROMOTE_SECRET not set: cannot create an admin user');

    const email = generateTestEmail('sso');
    await register(page, email);
    await logout(page);
    await page.context().clearCookies();
    const promoted = await page.request.post(`${TEST_URLS.authServer}/test/promote/${encodeURIComponent(email)}`, {
      headers: {
        'X-Test-Secret': process.env.TEST_PROMOTE_SECRET!,
        'X-E2E-Secret': process.env.E2E_CODE_SINK_SECRET ?? '',
      },
    });
    expect(promoted.ok()).toBe(true);

    // 1. Sign in to profile (the only sign-in form in this test)
    await page.goto(TEST_URLS.profileApp);
    await page.locator('#loggedOutView button:has-text("Sign In")').click();
    await expect(page).toHaveURL(new RegExp(`${TEST_URLS.authServer}/password/authorize`));
    await page.fill('input[type="email"]', email);
    await page.fill('input[type="password"]', PASSWORD);
    await page.click('form[data-component="form"] button[data-component="button"]');
    await expect(page.locator('#loggedInView')).toBeVisible({ timeout: 20000 });

    // 2. Admin and web: signed in without a form
    const forms = trackSignInForm(page);
    await openAdmin(page);
    await expect(page.locator('a:has-text("Users")')).toBeVisible({ timeout: 20000 });
    expect(new URL(page.url()).origin).toBe(new URL(TEST_URLS.adminDashboard).origin);

    if (WEB_URL) {
      await openWebSignIn(page);
      await page.waitForURL((u) => u.origin === new URL(WEB_URL).origin && !u.pathname.startsWith('/api/'), {
        timeout: 20000,
      });
      expect(page.url()).not.toContain('/auth/error');
      expect(await webSignedIn(page)).toBe(true);
    }
    expect(forms, 'no sign-in form after the first sign-in').toEqual([]);

    // 3. Log out (from profile)
    await page.goto(TEST_URLS.profileApp);
    await logout(page);
    expect(new URL(page.url()).origin).toBe(new URL(TEST_URLS.profileApp).origin);
    const authCookies = await page.context().cookies(TEST_URLS.authServer);
    expect(authCookies.find((c) => c.name === '__session')).toBeUndefined();

    // 4. Every app needs a sign-in again
    await page.goto(TEST_URLS.profileApp);
    await expect(page.locator('#loggedOutView')).toBeVisible({ timeout: 15000 });

    await openAdmin(page);
    await expect(page).toHaveURL(new RegExp(`${TEST_URLS.authServer}/password/authorize`), { timeout: 20000 });
    await expect(page.locator('input[type="password"]')).toBeVisible();

    if (WEB_URL) {
      // The web app is not in the front-channel chain until its /api/auth/logout
      // ships (AlUmmahNow#220), so drop its local session here: what matters is
      // that the auth server no longer signs it in silently.
      await page.context().clearCookies({ domain: new URL(WEB_URL).hostname });
      await openWebSignIn(page);
      await expect(page).toHaveURL(new RegExp(`${TEST_URLS.authServer}/password/authorize`), { timeout: 20000 });
    }
  });
});
