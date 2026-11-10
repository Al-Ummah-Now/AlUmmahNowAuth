/**
 * Release regression: the SSO journey on the auth server's own apps (SSO audit 2026-11-10).
 *
 * One sign-in (profile) opens the auth admin without a password (a member sees its "no access"
 * page, never a sign-in form). Another site cannot sign the browser out: a link to /logout from a
 * foreign page shows the in-page "Sign out of Al Ummah Now?" (English, or Arabic with ?lang=ar)
 * and the browser stays signed in until that page's own button is pressed. Pressing it signs out
 * of every app (single sign-out), and the profile app then asks for the password.
 *
 * The cross-app journey (videos, studio, admin, CMS, www) is AlUmmahNow's
 * apps/web/e2e/release/sso-journey.spec.ts.
 */
import { test, expect, type Page } from '@playwright/test';
import { register, expectSignInPage } from '../../fixtures/auth';
import { TEST_URLS, generateTestEmail } from '../../utils/test-data';

// Signs in with the test password: traces would record it
test.use({ trace: 'off' });

const FOREIGN = 'https://foreign-site.example';

/** A page on another site with one link to the auth server's /logout. */
async function openForeignLinkToLogout(page: Page, query: string): Promise<void> {
  await page.route(`${FOREIGN}/**`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><title>Elsewhere</title><a id="out" href="${TEST_URLS.authServer}/logout?${query}">Click</a>`,
    }),
  );
  await page.goto(`${FOREIGN}/page`);
  await page.click('#out');
  await page.waitForURL((u) => u.origin === new URL(TEST_URLS.authServer).origin && u.pathname === '/logout', { timeout: 20000 });
}

async function profileSignedIn(page: Page): Promise<boolean> {
  await page.goto(TEST_URLS.profileApp);
  await page.waitForLoadState('load');
  return page.locator('#loggedInView').isVisible({ timeout: 15000 }).catch(() => false);
}

test.describe('Release: SSO journey (auth apps)', () => {
  test.setTimeout(150000);

  for (const lang of ['en', 'ar'] as const) {
    test(`sign in once, the auth admin opens without a password; a foreign site cannot sign out (${lang})`, async ({ page }) => {
      const email = generateTestEmail(`sso-journey-${lang}`);
      await register(page, email);
      await expect(page.locator('#loggedInView')).toBeVisible();

      // The auth admin: signed in already (a member gets "no access"), no password form
      await page.goto(TEST_URLS.adminDashboard);
      await page.waitForLoadState('load');
      expect(new URL(page.url()).origin, `auth admin sent the browser to ${page.url()}`).toBe(new URL(TEST_URLS.adminDashboard).origin);
      await expect(page.locator('input[type="password"]')).toHaveCount(0);

      // Another site's link to /logout: the confirmation page, in the link's language
      await openForeignLinkToLogout(page, `lang=${lang}&return=${encodeURIComponent(`${TEST_URLS.profileApp}/`)}`);
      const confirm = page.locator('[data-page="sign-out-confirm"]');
      await expect(confirm).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('lang', lang);
      await expect(page.locator('html')).toHaveAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr');
      await expect(confirm.locator('h1')).toHaveText(lang === 'ar' ? 'تسجيل الخروج من الأمة الآن؟' : 'Sign out of Al Ummah Now?');

      // Nothing was signed out by the foreign link
      expect(await profileSignedIn(page), 'a foreign link signed the browser out').toBe(true);

      // The page's own button signs out of every app
      await openForeignLinkToLogout(page, `lang=${lang}&return=${encodeURIComponent(`${TEST_URLS.profileApp}/`)}`);
      await page.click('[data-action="sign-out"]');
      await expectSignInPage(page, 45000);
      await page.goto(TEST_URLS.adminDashboard);
      await expectSignInPage(page);
      expect(await profileSignedIn(page)).toBe(false);
    });
  }
});
