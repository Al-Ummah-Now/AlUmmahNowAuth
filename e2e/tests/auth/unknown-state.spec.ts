/**
 * Sign-in must never end on OpenAuth's raw "The browser was in an unknown
 * state" error (text/plain, or JSON invalid_state from the enterprise issuer).
 *
 * Before openauth 1.0.19 the pending authorization lived in ONE cookie shared by
 * every tab and client: the back button after signing in, a second sign-in in
 * another tab (which could even complete to the wrong client), a stale login
 * page, and a bookmarked /password/authorize all hit that error. Each sign-in
 * now carries its own browser-bound flow id, and an unrecoverable state renders
 * a friendly en/ar "Start sign-in again" page.
 */
import { test, expect, type Page } from '@playwright/test';
import { register, logout, expectSignInPage } from '../../fixtures/auth';
import { TEST_URLS, generateTestEmail } from '../../utils/test-data';

const PASSWORD = 'TestPassword123!'; // same as fixtures/auth.ts
const RAW_ERROR = /unknown state|invalid_state/i;

/** Lands on the auth server's login page by opening the profile app (no landing page). */
async function openProfileSignIn(page: Page): Promise<string> {
  await page.goto(TEST_URLS.profileApp);
  await expect(page).toHaveURL(new RegExp(`${TEST_URLS.authServer}/password/authorize`));
  await expect(page.locator('input[type="password"]')).toBeVisible();
  return page.url();
}

async function submitLogin(page: Page, email: string) {
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', PASSWORD);
  // The submit button is localized ("Continue" / "متابعة")
  await page.click('form[data-component="form"] button[data-component="button"]');
}

async function expectNoRawError(page: Page) {
  await expect(page.locator('body')).not.toHaveText(RAW_ERROR);
}

async function expectRestartPage(page: Page) {
  const button = page.locator('[data-action="restart"]');
  await expect(button).toBeVisible({ timeout: 15000 });
  await expectNoRawError(page);
  return button;
}

/** A registered, signed-out user with no cookies left. */
async function signedOutUser(page: Page, prefix: string): Promise<string> {
  const email = generateTestEmail(prefix);
  await register(page, email);
  await logout(page);
  await page.context().clearCookies();
  return email;
}

test.describe('Sign-in never shows the raw unknown-state error', () => {
  test.setTimeout(120000);

  test('back after signing in, then resubmitting the form, returns to the app', async ({ page }) => {
    const email = await signedOutUser(page, 'us-back');

    const loginUrl = await openProfileSignIn(page);
    expect(loginUrl).toContain('auth_flow=');
    await submitLogin(page, email);
    await expect(page.locator('#loggedInView')).toBeVisible({ timeout: 20000 });

    // Back to the login page, sign in again with the same (now completed) flow
    await page.goto(loginUrl);
    await submitLogin(page, email);
    await page.waitForLoadState('networkidle').catch(() => {});
    expect(new URL(page.url()).origin).toBe(new URL(TEST_URLS.profileApp).origin);
    await expectNoRawError(page);
  });

  test('two tabs, two clients: each completes to its own app', async ({ page, context }) => {
    test.skip(!process.env.TEST_PROMOTE_SECRET, 'TEST_PROMOTE_SECRET not set: cannot create an admin user');
    const email = await signedOutUser(page, 'us-tabs');
    const promoted = await page.request.post(`${TEST_URLS.authServer}/test/promote/${encodeURIComponent(email)}`, {
      headers: {
        'X-Test-Secret': process.env.TEST_PROMOTE_SECRET!,
        'X-E2E-Secret': process.env.E2E_CODE_SINK_SECRET ?? '',
      },
    });
    expect(promoted.ok()).toBe(true);

    // Tab 1: profile sign-in page. Tab 2: admin sign-in page (opened second).
    await openProfileSignIn(page);
    const adminTab = await context.newPage();
    await adminTab.goto(TEST_URLS.adminDashboard);
    await expect(adminTab).toHaveURL(new RegExp(`${TEST_URLS.authServer}/password/authorize`));

    // Complete the FIRST tab first: it must go to profile, not to admin
    await submitLogin(page, email);
    await expect(page.locator('#loggedInView')).toBeVisible({ timeout: 20000 });
    expect(new URL(page.url()).origin).toBe(new URL(TEST_URLS.profileApp).origin);

    // The second tab still completes, to admin
    await submitLogin(adminTab, email);
    await expect(adminTab).toHaveURL(new RegExp(TEST_URLS.adminDashboard), { timeout: 20000 });
    await expectNoRawError(adminTab);
  });

  test('a stale login page shows the friendly page that leads back to the app', async ({ page, context }) => {
    const email = await signedOutUser(page, 'us-stale');
    await openProfileSignIn(page);

    // The page outlived its sign-in (expired/cleared cookies, ITP, in-app browser)
    await context.clearCookies();
    await submitLogin(page, email);

    const button = await expectRestartPage(page);
    await expect(button).toHaveAttribute('href', `${new URL(TEST_URLS.profileApp).origin}/`);
    await button.click();
    await expectSignInPage(page);
  });

  test('a direct /password/authorize link shows the friendly page (en + ar)', async ({ page }) => {
    const email = await signedOutUser(page, 'us-direct');

    await page.goto(`${TEST_URLS.authServer}/password/authorize`);
    await submitLogin(page, email);
    const button = await expectRestartPage(page);
    await expect(button).toHaveText('Start sign-in again');
    expect(await button.getAttribute('href')).toMatch(/^https?:\/\//);

    await page.context().clearCookies();
    await page.goto(`${TEST_URLS.authServer}/password/authorize?lang=ar`);
    await submitLogin(page, email);
    const arButton = await expectRestartPage(page);
    await expect(arButton).toHaveText('ابدأ تسجيل الدخول من جديد');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  });
});
