/**
 * E2E Test: Profile app switcher (header launcher + "Your apps" cards)
 *
 * - A regular member sees the www site, Al Ummah Now and Profile.
 * - An admin also sees the CMS, Al Ummah Now Admin and Auth Admin.
 * - Links point at the environment's own hosts (QA links never go to prod).
 * - The launcher follows the menu-button keyboard pattern.
 * - Arabic renders RTL, including on a phone-sized viewport.
 *
 * Screenshots are written to each test's folder under test-results/ as app-switcher-*.png (uploaded by CI).
 */

import { test, expect, Page } from '@playwright/test';
import { login, register } from '../../fixtures/auth';
import { TEST_URLS, TEST_USERS } from '../../utils/test-data';

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
  const trigger = page.locator('#appsTrigger');
  await expect(trigger).toBeVisible();
  await trigger.click();
  await expect(page.locator('#appsMenu')).toBeVisible();
  return page.locator('#appsMenu [role="menuitem"]');
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
  test('regular user sees www, Al Ummah Now and Profile, with env URLs', async ({ page }) => {
    const user = TEST_USERS.user();
    await login(page, user.email);

    // The old standalone admin button is gone
    await expect(page.locator('#navMenu a:has-text("Admin")')).toHaveCount(0);

    const items = await openLauncher(page);
    await expect(items).toHaveCount(3);
    await expect(page.locator('#appsMenu [data-app]')).toHaveCount(3);
    await expect(page.locator('#appsMenu [data-app="www"]')).toHaveAttribute('href', EXPECTED_URLS.www);
    await expect(page.locator('#appsMenu [data-app="cms"]')).toHaveCount(0);
    await expect(page.locator('#appsMenu [data-app="videos"]')).toHaveAttribute('href', EXPECTED_URLS.videos);
    await expect(page.locator('#appsMenu [data-app="profile"]')).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('#appsMenu')).not.toContainText('Admin');
    await shot(page, 'member-desktop-menu');

    // "Your apps" cards: no admin apps for members, no greyed-out entries
    await page.keyboard.press('Escape');
    const cards = page.locator('#yourApps .app-card');
    await expect(cards).toHaveCount(2);
    await expect(cards.first()).toHaveAttribute('href', EXPECTED_URLS.www);
    await expect(cards.nth(1)).toHaveAttribute('href', EXPECTED_URLS.videos);
    await expect(page.locator('#yourApps')).not.toContainText('Administration');
  });

  test('launcher is keyboard accessible (menu-button pattern)', async ({ page }) => {
    const user = TEST_USERS.user();
    await login(page, user.email);

    const trigger = page.locator('#appsTrigger');
    const menu = page.locator('#appsMenu');
    const items = menu.locator('[role="menuitem"]');

    await expect(trigger).toHaveAttribute('aria-haspopup', 'true');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(trigger).toHaveAccessibleName(/apps/i);

    await trigger.focus();
    await page.keyboard.press('Enter');
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(menu).toBeVisible();
    await expect(items.nth(0)).toBeFocused();

    await page.keyboard.press('ArrowDown');
    await expect(items.nth(1)).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(items.nth(2)).toBeFocused();
    await page.keyboard.press('ArrowDown'); // wraps
    await expect(items.nth(0)).toBeFocused();
    await page.keyboard.press('End');
    await expect(items.last()).toBeFocused();
    await page.keyboard.press('Home');
    await expect(items.first()).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(trigger).toBeFocused();

    // ArrowUp opens on the last item
    await page.keyboard.press('ArrowUp');
    await expect(items.last()).toBeFocused();

    // Enter follows the focused link in the same tab
    await page.keyboard.press('Home');
    const [request] = await Promise.all([
      page.waitForRequest((r) => r.isNavigationRequest() && r.url().startsWith(EXPECTED_URLS.www), { timeout: 15000 }),
      page.keyboard.press('Enter'),
    ]);
    expect(request.url().startsWith(EXPECTED_URLS.www)).toBe(true);
    expect(page.context().pages()).toHaveLength(1);
  });

  test('admin also sees the CMS, Al Ummah Now Admin and Auth Admin', async ({ page }) => {
    const admin = TEST_USERS.admin();
    await register(page, admin.email);
    await promoteToAdmin(page, admin.email);

    // Role claims are issued at sign-in: start a fresh session to pick up "Admin"
    await page.context().clearCookies();
    await page.goto(TEST_URLS.profileApp); // reload so login() sees the signed-out view
    await login(page, admin.email);

    const items = await openLauncher(page);
    await expect(items).toHaveCount(6);
    await expect(page.locator('#appsMenu [data-app="cms"]')).toHaveAttribute('href', EXPECTED_URLS.cms);
    await expect(page.locator('#appsMenu [data-app="videos"]')).toHaveAttribute('href', EXPECTED_URLS.videos);
    await expect(page.locator('#appsMenu [data-app="content-admin"]')).toHaveAttribute('href', EXPECTED_URLS['content-admin']);
    await expect(page.locator('#appsMenu [data-app="auth-admin"]')).toHaveAttribute('href', EXPECTED_URLS['auth-admin']);
    await expect(page.locator('#appsMenu [role="group"]')).toHaveCount(2);
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
    await expect(page.locator('#appsMenu [data-app="videos"]')).toContainText('الأمة الآن');
    await expect(page.locator('#appsMenu [data-app="auth-admin"]')).toHaveAttribute('href', EXPECTED_URLS['auth-admin']);
    const box = await page.locator('#appsMenu').boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    await shot(page, 'admin-mobile-ar-menu');

    // The language choice sticks via cookie; ?lang=en switches back
    await page.goto(TEST_URLS.profileApp);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await page.goto(`${TEST_URLS.profileApp}/?lang=en`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  });
});
