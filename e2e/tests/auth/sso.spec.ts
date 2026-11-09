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
import { register, logout, expectSignInPage } from '../../fixtures/auth';
import { TEST_URLS, generateTestEmail } from '../../utils/test-data';
import { fillSecret } from '../../utils/secret-input';
import { TEST_PASSWORD as PASSWORD } from '../../utils/test-credentials';

// Signs in with the test password / one-time codes (or sends test secrets in headers):
// traces would record them, so none for this file. See e2e/utils/secret-input.ts.
test.use({ trace: 'off' });
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

/** Opens the admin dashboard (no landing page: it signs in silently or shows the form). */
async function openAdmin(page: Page) {
  await page.goto(TEST_URLS.adminDashboard);
}

/**
 * Opens the web app signed out and clicks its own Sign In (menu → Sign In).
 * The page first tries a silent sign-in of its own (AlUmmahNow#463), so wait
 * until that has come back to the web app before using the menu.
 */
async function openWebSignIn(page: Page) {
  await page.goto(`${WEB_URL}/en`);
  await page.waitForURL((u) => u.origin === WEB_URL && !u.pathname.startsWith('/api/'), { timeout: 20000 });
  await page.waitForLoadState('load');
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
    await expect(page).toHaveURL(new RegExp(`${TEST_URLS.authServer}/password/authorize`));
    await page.fill('input[type="email"]', email);
    await fillSecret(page.locator('input[type="password"]').first(), PASSWORD);
    await page.click('form[data-component="form"] button[data-component="button"]');
    await expect(page.locator('#loggedInView')).toBeVisible({ timeout: 20000 });

    // 2. Admin and web: signed in without a form
    const forms = trackSignInForm(page);
    await openAdmin(page);
    await expect(page.locator('a:has-text("Users")')).toBeVisible({ timeout: 20000 });
    expect(new URL(page.url()).origin).toBe(new URL(TEST_URLS.adminDashboard).origin);

    if (WEB_URL) {
      // Opening the web app signs it in by itself (AlUmmahNow#463): its OAuth
      // callback comes straight back from /authorize, with no click and no form
      const callback = page.waitForResponse((r) => r.url().startsWith(`${WEB_URL}/api/callback`), { timeout: 20000 });
      await page.goto(`${WEB_URL}/en`);
      await callback;
      await page.waitForLoadState('load');
      expect(page.url()).not.toContain('/auth/error');
      expect(await webSignedIn(page)).toBe(true);
    }
    expect(forms, 'no sign-in form after the first sign-in').toEqual([]);

    // 3. Log out (from profile)
    await page.goto(TEST_URLS.profileApp);
    await logout(page);
    const authCookies = await page.context().cookies(TEST_URLS.authServer);
    expect(authCookies.find((c) => c.name === '__session')).toBeUndefined();

    // 4. Every app needs a sign-in again
    await page.goto(TEST_URLS.profileApp);
    await expectSignInPage(page);

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
