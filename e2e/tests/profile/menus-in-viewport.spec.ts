/**
 * No menu renders outside the screen (owner decision 2026-11-13; AlUmmahNow docs/design/NAV.md
 * "Menus never leave the screen"): the profile account menu and the accounts admin's account menu,
 * at phone widths (320 / 375 / 414) and a landscape phone, in English (LTR) and Arabic (RTL).
 * Profile and the accounts admin have no Light / Dark control (profile follows the device, the admin
 * is always dark), so there is no "System" option to remove here.
 */
import { test, expect, type Locator, type Page } from '@playwright/test';
import { login } from '../../fixtures/auth';
import { loginAdmin } from '../../fixtures/admin';
import { TEST_URLS, TEST_USERS } from '../../utils/test-data';

// Signs in with test codes: no traces (see e2e/utils/secret-input.ts)
test.use({ trace: 'off' });

const VIEWPORTS = [
  { width: 320, height: 640 },
  { width: 375, height: 667 },
  { width: 414, height: 896 },
  { width: 844, height: 390 },
] as const;

async function expectInViewport(page: Page, popup: Locator, what: string) {
  await expect(popup, what).toBeVisible();
  await page.waitForTimeout(150);
  const box = (await popup.boundingBox())!;
  const vp = page.viewportSize()!;
  expect.soft(box.x, `${what}: left edge`).toBeGreaterThanOrEqual(-1);
  expect.soft(box.y, `${what}: top edge`).toBeGreaterThanOrEqual(-1);
  expect.soft(box.x + box.width, `${what}: right edge`).toBeLessThanOrEqual(vp.width + 1);
  expect.soft(box.y + box.height, `${what}: bottom edge`).toBeLessThanOrEqual(vp.height + 1);
  expect.soft(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), `${what}: page scrolls sideways`).toBeLessThanOrEqual(0);
}

test.describe('Menus stay inside the viewport', () => {
  test.skip(({ browserName, isMobile }) => browserName !== 'chromium' || isMobile, 'viewports are set per test: one browser');

  test('profile account menu, every phone size, en and ar', async ({ page }) => {
    test.setTimeout(120_000);
    await login(page, TEST_USERS.user().email);
    for (const vp of VIEWPORTS) {
      for (const lang of ['en', 'ar'] as const) {
        await page.setViewportSize(vp);
        await page.goto(`${TEST_URLS.profileApp}/?lang=${lang}`);
        const trigger = page.locator('#accountTrigger');
        await trigger.click();
        await expectInViewport(page, page.locator('#accountDropdown'), `profile account menu ${vp.width}×${vp.height} ${lang}`);
        await page.keyboard.press('Escape');
        await expect(trigger).toBeFocused();
      }
    }
  });

  test('accounts admin account menu, every phone size, en and ar', async ({ page }) => {
    test.setTimeout(120_000);
    await loginAdmin(page, TEST_USERS.admin().email);
    for (const vp of VIEWPORTS) {
      for (const lang of ['en', 'ar'] as const) {
        await page.setViewportSize(vp);
        await page.goto(`${TEST_URLS.adminDashboard}/users?lang=${lang}`);
        const trigger = page.getByTestId('account-menu');
        await trigger.click();
        await expectInViewport(page, page.locator('.aun-menu[role="menu"]').first(), `admin account menu ${vp.width}×${vp.height} ${lang}`);
        await page.keyboard.press('Escape');
      }
    }
  });
});
