/**
 * #219: a member without an admin role opening the auth admin.
 *
 * Before: /forbidden sent the browser back to the account picker after 3 s;
 * picking the same account landed on /forbidden again, in a loop. And the
 * picker's "Sign out" only dropped the account from the auth server, leaving
 * profile (and videos, admin) signed in.
 *
 * Now /forbidden stays put with sign out / another account / your apps, in
 * English and Arabic, and the picker's "Sign out" of the last account runs
 * single sign-out.
 */
import { test, expect, type Page } from '@playwright/test';
import { register, expectSignInPage } from '../../fixtures/auth';
import { TEST_URLS, generateTestEmail } from '../../utils/test-data';

// Signs in with the test password / one-time codes (or sends test secrets in headers):
// traces would record them, so none for this file. See e2e/utils/secret-input.ts.
test.use({ trace: 'off' });

const admin = () => new URL(TEST_URLS.adminDashboard).origin;

/** Signed in on profile (shared sign-in), then opens the auth admin as that member. */
async function memberOnForbidden(page: Page, prefix: string) {
  await register(page, generateTestEmail(prefix));
  // No landing page: the admin signs in silently with the shared sign-in
  await page.goto(TEST_URLS.adminDashboard);
  await expect(page).toHaveURL(new RegExp(`^${admin()}/forbidden`), { timeout: 30000 });
}

async function authSession(page: Page) {
  return (await page.context().cookies(TEST_URLS.authServer)).find((c) => c.name === '__session');
}

test.describe('Auth admin: member without an admin role (#219)', () => {
  test.setTimeout(120000);

  test('the access-denied page stays put and offers sign out, another account and your apps', async ({ page }) => {
    await memberOnForbidden(page, 'forbidden-stays');

    // Navigation requests only: hydration's history.replaceState also fires
    // framenavigated, for the same URL, without leaving the page
    const navigations: string[] = [];
    page.on('request', (r) => {
      if (r.isNavigationRequest() && r.frame() === page.mainFrame()) navigations.push(r.url());
    });
    // The old page left for the picker after 3 s
    await page.waitForTimeout(6000);
    expect(navigations, `left the page on its own: ${navigations.join(' → ')}`).toEqual([]);
    expect(new URL(page.url()).pathname).toBe('/forbidden');

    await expect(page.locator('h1')).toHaveText('Access denied');
    const switchAccount = page.getByTestId('forbidden-switch-account');
    await expect(switchAccount).toHaveAttribute('href', new RegExp(`^${TEST_URLS.authServer}/authorize\\?.*prompt=select_account`));
    await expect(page.getByTestId('forbidden-sign-out')).toHaveAttribute('href', '/logout');
    await expect(page.getByTestId('forbidden-your-apps')).toHaveAttribute('href', `${TEST_URLS.profileApp.replace(/\/$/, '')}/`);

    // A crafted ?redirect= is ignored (it used to become window.location.href)
    await page.goto(`${admin()}/forbidden?email=x%40example.com&redirect=${encodeURIComponent('javascript:alert(1)')}`);
    await page.waitForTimeout(4000);
    expect(new URL(page.url()).pathname).toBe('/forbidden');

    // Arabic
    await page.getByTestId('forbidden-language').click();
    await expect(page.locator('[data-testid="forbidden"]').locator('xpath=..')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('h1')).toHaveText('تم رفض الوصول');
    await expect(page.getByTestId('forbidden-sign-out')).toHaveText('تسجيل الخروج');

    // Sign out ends the shared sign-in: profile is signed out and the admin asks for a password
    await page.goto(`${admin()}/forbidden`);
    await page.getByTestId('forbidden-sign-out').click();
    // The chain returns to the admin, which (signed out) goes straight to the form
    await expectSignInPage(page, 30000);
    expect(await authSession(page)).toBeUndefined();
    await page.goto(TEST_URLS.profileApp);
    await expectSignInPage(page);
  });

  test('"Sign out" on the account picker signs out of every app', async ({ page }) => {
    await memberOnForbidden(page, 'forbidden-picker');

    await page.getByTestId('forbidden-switch-account').click();
    await expect(page).toHaveURL(new RegExp(`^${TEST_URLS.authServer}/authorize`), { timeout: 20000 });
    const signOut = page.locator('form[action="/account-picker/remove"] button[type="submit"]').first();
    await expect(signOut).toBeVisible();
    await signOut.click();

    // The /logout chain walks every app and returns to the app being signed in
    // to, which (signed out) goes straight to the sign-in form
    await expectSignInPage(page, 30000);
    expect(await authSession(page)).toBeUndefined();
    await page.goto(TEST_URLS.profileApp);
    await expectSignInPage(page);
  });
});
