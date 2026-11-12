/**
 * E2E Test: Profile app switcher (the account menu's "Al Ummah Now apps" + "Your apps" cards)
 *
 * The shared nav (AlUmmahNow docs/design/NAV.md): the other apps live in the account menu, in the
 * same order and labels as every app (Website, Videos, Your profile, Content management,
 * Videos admin, Accounts admin); this app is left out.
 * - A regular member sees Website and Videos.
 * - An admin also sees Content management, Videos admin and Accounts admin.
 * - Links point at the environment's own hosts (QA links never go to prod).
 * - The account menu is keyboard accessible.
 * - Arabic renders RTL, including on a phone-sized viewport.
 *
 * Screenshots are written to each test's folder under test-results/ as app-switcher-*.png (uploaded by CI).
 */

import { test, expect, Page } from '@playwright/test';
import { login, register } from '../../fixtures/auth';
import { TEST_URLS, TEST_USERS } from '../../utils/test-data';

// Signs in with the test password / one-time codes (or sends test secrets in headers):
// traces would record them, so none for this file. See e2e/utils/secret-input.ts.
test.use({ trace: 'off' });

const profileHost = new URL(TEST_URLS.profileApp).hostname;
const ENV: 'qa' | 'production' | 'local' =
  profileHost === 'localhost' || profileHost === '127.0.0.1'
    ? 'local'
    : profileHost.includes('.qa.')
      ? 'qa'
      : 'production';

const EXPECTED_URLS = {
  qa: {
    www: 'https://www.qa.alummahnow.net',
    cms: 'https://cms.qa.alummahnow.net',
    videos: 'https://videos.qa.alummahnow.net',
    'content-admin': 'https://admin.qa.alummahnow.net',
    'auth-admin': 'https://admin.auth.qa.alummahnow.net',
  },
  production: {
    www: 'https://www.alummahnow.net',
    cms: 'https://cms.alummahnow.net',
    videos: 'https://videos.alummahnow.net',
    'content-admin': 'https://admin.alummahnow.net',
    'auth-admin': 'https://admin.auth.alummahnow.net',
  },
  local: {
    www: 'http://localhost:4321',
    cms: 'http://localhost:8585',
    videos: 'http://localhost:3001',
    'content-admin': 'http://localhost:3091',
    'auth-admin': 'http://localhost:3303',
  },
}[ENV];

const shot = (page: Page, name: string) =>
  page.screenshot({ path: test.info().outputPath(`app-switcher-${name}.png`), fullPage: false });

async function openLauncher(page: Page) {
  const trigger = page.locator('#accountTrigger');
  await expect(trigger).toBeVisible();
  await trigger.click();
  await expect(page.locator('#accountDropdown')).toBeVisible();
  return page.locator('#accountApps [role="menuitem"]');
}

async function promoteToAdmin(page: Page, email: string) {
  const response = await page.request.post(`${TEST_URLS.authServer}/test/promote/${encodeURIComponent(email)}`, {
    headers: {
      'X-Test-Secret': process.env.TEST_PROMOTE_SECRET ?? '',
      'X-E2E-Secret': process.env.E2E_CODE_SINK_SECRET ?? '',
    },
    failOnStatusCode: false,
  });
  expect(response.ok(), `promote failed: ${response.status()} ${await response.text()}`).toBe(true);
}

test.describe('Profile app switcher', () => {
  test('regular user sees Website and Videos, with env URLs', async ({ page }) => {
    const user = TEST_USERS.user();
    await login(page, user.email);

    // The old standalone admin button is gone
    await expect(page.locator('#navMenu a:has-text("Admin")')).toHaveCount(0);

    const items = await openLauncher(page);
    await expect(items).toHaveCount(2);
    await expect(items.first()).toHaveText('Website');
    await expect(page.locator('#accountApps [data-app="www"]')).toHaveAttribute('href', EXPECTED_URLS.www);
    await expect(page.locator('#accountApps [data-app="cms"]')).toHaveCount(0);
    await expect(page.locator('#accountApps [data-app="videos"]')).toHaveAttribute('href', EXPECTED_URLS.videos);
    // This app is left out of its own list
    await expect(page.locator('#accountApps [data-app="profile"]')).toHaveCount(0);
    await expect(page.locator('#accountApps')).not.toContainText('admin');
    await shot(page, 'member-desktop-menu');

    // "Your apps" cards: no admin apps for members, no greyed-out entries
    await page.keyboard.press('Escape');
    const cards = page.locator('#yourApps .app-card');
    await expect(cards).toHaveCount(2);
    await expect(cards.first()).toHaveAttribute('href', EXPECTED_URLS.www);
    await expect(cards.nth(1)).toHaveAttribute('href', EXPECTED_URLS.videos);
    await expect(page.locator('#yourApps')).not.toContainText('Administration');
  });

  test('the account menu is keyboard accessible', async ({ page }) => {
    const user = TEST_USERS.user();
    await login(page, user.email);

    const trigger = page.locator('#accountTrigger');
    const menu = page.locator('#accountDropdown');
    const items = menu.locator('a:visible, button:visible');

    await expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');

    // ArrowDown on the button opens the menu at its first item
    await trigger.focus();
    await page.keyboard.press('ArrowDown');
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(menu).toBeVisible();
    await expect(items.first()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(items.nth(1)).toBeFocused();
    await page.keyboard.press('End');
    await expect(items.last()).toBeFocused();
    await page.keyboard.press('ArrowDown'); // wraps
    await expect(items.first()).toBeFocused();
    await page.keyboard.press('Home');
    await expect(items.first()).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(trigger).toBeFocused();

    // An app link opens in the same tab
    await trigger.click();
    const [request] = await Promise.all([
      page.waitForRequest((r) => r.isNavigationRequest() && r.url().startsWith(EXPECTED_URLS.www), { timeout: 15000 }),
      page.locator('#accountApps [data-app="www"]').click(),
    ]);
    expect(request.url().startsWith(EXPECTED_URLS.www)).toBe(true);
    expect(page.context().pages()).toHaveLength(1);
  });

  test('admin also sees Content management, Videos admin and Accounts admin', async ({ page }) => {
    const admin = TEST_USERS.admin();
    await register(page, admin.email);
    await promoteToAdmin(page, admin.email);

    // Role claims are issued at sign-in: start a fresh session to pick up "Admin"
    await page.context().clearCookies();
    await page.goto(TEST_URLS.profileApp); // reload so login() sees the signed-out view
    await login(page, admin.email);

    const items = await openLauncher(page);
    // The shared order: Website, Videos, Content management, Videos admin, Accounts admin
    await expect(items).toHaveText(['Website', 'Videos', 'Content management', 'Videos admin', 'Accounts admin']);
    await expect(page.locator('#accountApps [data-app="cms"]')).toHaveAttribute('href', EXPECTED_URLS.cms);
    await expect(page.locator('#accountApps [data-app="videos"]')).toHaveAttribute('href', EXPECTED_URLS.videos);
    await expect(page.locator('#accountApps [data-app="content-admin"]')).toHaveAttribute('href', EXPECTED_URLS['content-admin']);
    await expect(page.locator('#accountApps [data-app="auth-admin"]')).toHaveAttribute('href', EXPECTED_URLS['auth-admin']);
    await shot(page, 'admin-desktop-menu');

    await page.keyboard.press('Escape');
    await expect(page.locator('#yourApps .app-card')).toHaveCount(5);
    await page.locator('#yourApps').scrollIntoViewIfNeeded();
    await shot(page, 'admin-desktop-cards');

    // Arabic on a phone: RTL, translated, menu fits the viewport
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${TEST_URLS.profileApp}/?lang=ar`);
    await expect(page.locator('#loggedInView')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    await expect(page.locator('#yourAppsHeading')).toHaveText('تطبيقاتك');
    await shot(page, 'admin-mobile-ar');

    await openLauncher(page);
    await expect(page.locator('#accountApps [data-app="videos"]')).toHaveText('المرئيات');
    await expect(page.locator('#accountApps [data-app="auth-admin"]')).toHaveAttribute('href', EXPECTED_URLS['auth-admin']);
    const box = await page.locator('#accountDropdown').boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    await shot(page, 'admin-mobile-ar-menu');

    // English unless the link asks for Arabic: no lang (or an unsupported one) is English
    await page.goto(TEST_URLS.profileApp);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await page.goto(`${TEST_URLS.profileApp}/?lang=fr`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  });
});
