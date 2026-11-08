/**
 * /authorize only serves registered clients (CLIENT_REGISTRY_MODE=enforce on
 * QA). Before, any client_id with a redirect_uri on our domain got a sign-in
 * form: prod web even sent client_id=undefined and nothing noticed.
 */
import { test, expect, type Page } from '@playwright/test';
import { TEST_URLS } from '../../utils/test-data';

const PROFILE_CLIENT_ID = '109a1087-6626-40f7-8a7f-7f42f83f4f30';
const PROFILE_CALLBACK = `${TEST_URLS.profileApp}/callback`;

function authorizeUrl(clientId: string, redirect: string, extra = '') {
  return `${TEST_URLS.authServer}/authorize?client_id=${encodeURIComponent(clientId)}&response_type=code&state=s&redirect_uri=${encodeURIComponent(redirect)}${extra}`;
}

async function expectClientError(page: Page, reason: string) {
  const card = page.locator('[data-page="client-error"]');
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('data-error', reason);
  expect(new URL(page.url()).origin).toBe(new URL(TEST_URLS.authServer).origin);
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
}

test.describe('Client registry at /authorize', () => {
  test('a registered app still gets the sign-in form', async ({ page }) => {
    await page.goto(authorizeUrl(PROFILE_CLIENT_ID, PROFILE_CALLBACK));
    await expect(page).toHaveURL(new RegExp(`${TEST_URLS.authServer}/password/authorize`));
    await expect(page.locator('input[type="password"]')).toBeVisible();
  });

  test('an unknown client_id gets a clear error page, not a sign-in form', async ({ page }) => {
    for (const id of ['undefined', 'admin-dashboard-m2m']) {
      const res = await page.goto(authorizeUrl(id, PROFILE_CALLBACK));
      expect(res?.status()).toBe(400);
      await expectClientError(page, 'unknown_client');
    }
  });

  test('a redirect_uri the app has not registered is refused (en + ar)', async ({ page }) => {
    const res = await page.goto(authorizeUrl(PROFILE_CLIENT_ID, `${TEST_URLS.profileApp}/not-the-callback`));
    expect(res?.status()).toBe(400);
    await expectClientError(page, 'redirect_uri_not_registered');
    await expect(page.locator('h1[data-component="title"]')).toHaveText("This app can't sign you in here");

    await page.goto(authorizeUrl(PROFILE_CLIENT_ID, `${TEST_URLS.profileApp}/not-the-callback`, '&lang=ar'));
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('h1[data-component="title"]')).toHaveText('لا يمكن لهذا التطبيق تسجيل دخولك هنا');
  });
});
