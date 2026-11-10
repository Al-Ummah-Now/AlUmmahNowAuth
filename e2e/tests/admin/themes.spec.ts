/**
 * E2E Test: Auth admin manages the sign-in themes
 *
 * An Auth admin duplicates a built-in theme, changes a colour and its card
 * header art, publishes it and makes it the default of a test app; that
 * app's sign-in pages then show it (en + ar). A per-call ?theme= still wins,
 * and an unknown id falls back to the app's default. Everything it creates
 * (the theme, the test app, the app default) is removed at the end, whatever
 * happens.
 */
import { test, expect, type Page } from '@playwright/test';
import { loginAdmin } from '../../fixtures/admin';
import { TEST_URLS, TEST_USERS } from '../../utils/test-data';

// Signs in with the test password / one-time codes: traces would record them.
test.use({ trace: 'off' });

const SUFFIX = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const THEME_ID = `e2e-${SUFFIX}`;
const CLIENT_NAME = `E2E theme app ${SUFFIX}`;
const CALLBACK = `${TEST_URLS.profileApp}/e2e-theme-callback-${SUFFIX}`;
const MARK = `e2e-mark-${SUFFIX}`;
const PAGE_BG = '#1d4f6e';
const PAGE_BG_RGB = 'rgb(29, 79, 110)';
const HEADER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40"><rect width="120" height="40" fill="#1d4f6e"/><circle id="${MARK}" cx="60" cy="20" r="12" fill="#f4ae3a"/></svg>`;

/** Screenshots for review, kept with the test results (no secrets are on these pages). */
const shot = (page: Page, name: string) => page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true });

const admin = (path: string) => `${TEST_URLS.adminDashboard}${path}`;

function authorizeUrl(clientId: string, extra: Record<string, string> = {}) {
  const q = new URLSearchParams({ client_id: clientId, response_type: 'code', state: 's', redirect_uri: CALLBACK, ...extra });
  return `${TEST_URLS.authServer}/authorize?${q}`;
}

async function expectStatus(page: Page, text: RegExp) {
  await expect(page.locator('[role="status"]').filter({ hasText: text })).toBeVisible({ timeout: 20000 });
}

/** Opens the test app's sign-in page and checks it wears the test theme. */
async function expectSignInThemed(page: Page, clientId: string, lang: 'en' | 'ar') {
  await page.emulateMedia({ colorScheme: 'light' });
  // Theme settings are cached briefly by Auth: allow a few retries
  await expect(async () => {
    await page.goto(authorizeUrl(clientId, { lang }));
    await expect(page).toHaveURL(/\/password\/authorize/);
    await expect(page.locator('html')).toHaveAttribute('data-theme', THEME_ID, { timeout: 2000 });
  }).toPass({ timeout: 60000, intervals: [2000, 5000, 10000] });
  const html = page.locator('html');
  await expect(html).toHaveAttribute('lang', lang);
  await expect(html).toHaveAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr');
  await expect(page.locator('input[type="password"]')).toBeVisible();
  await expect(page.locator(`[id="${MARK}"]`)).toHaveCount(1);
  await shot(page, `sign-in-${lang}`);
  const bg = await page.locator('[data-component="root"]').evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).toBe(PAGE_BG_RGB);
}

test.describe('Admin sign-in themes', () => {
  test.setTimeout(300000);

  test('duplicate, edit, publish, use as an app default, then clean up', async ({ page, browser }) => {
    page.on('dialog', (d) => d.accept());
    await loginAdmin(page, TEST_USERS.admin().email);

    let clientId: string | undefined;
    let themeCreated = false;
    try {
      // ---- a test app to give the theme to
      await page.goto(admin('/clients'));
      await page.getByRole('button', { name: 'Add Client' }).click();
      await page.fill('#client_name', CLIENT_NAME);
      await page.fill('#redirect_uris', CALLBACK);
      await page.getByRole('button', { name: 'Create Client' }).click();
      const idBox = page.locator('[role="dialog"]').filter({ hasText: 'Client ID' }).locator('code').first();
      await expect(idBox).toBeVisible({ timeout: 20000 });
      clientId = (await idBox.textContent())!.trim();
      expect(clientId).toMatch(/\S{8,}/);
      await page.getByRole('button', { name: 'Done' }).click();

      // ---- the list: built-ins are there, Nahas is duplicated
      await page.goto(admin('/themes'));
      await expect(page.locator('h2', { hasText: 'Sign-in themes' })).toBeVisible();
      for (const id of ['classic', 'fawanees', 'lantern', 'nahas', 'zujaj']) await expect(page.getByTestId(`theme-${id}`)).toBeVisible();
      await shot(page, 'list');
      await page.getByTestId('theme-nahas').getByRole('button', { name: 'Duplicate' }).click();
      await page.fill('#dup-id', THEME_ID);
      await page.fill('#dup-en', `E2E ${SUFFIX}`);
      await page.fill('#dup-ar', `اختبار ${SUFFIX}`);
      await page.locator('[role="dialog"]').getByRole('button', { name: 'Duplicate' }).click();
      await expect(page).toHaveURL(admin(`/themes/${THEME_ID}`), { timeout: 20000 });
      themeCreated = true;
      await expect(page.getByText('Not published yet', { exact: true })).toBeVisible();

      // ---- the live preview shows the real sign-in page
      const frame = page.frameLocator('[data-testid="theme-preview"]');
      await expect(frame.locator('input[type="password"]')).toBeVisible({ timeout: 30000 });
      await shot(page, 'builder-colours');

      // ---- an image: new card header art, uploaded straight into its slot
      await page.getByRole('tab', { name: 'Images' }).click();
      await page.setInputFiles('#asset-file', { name: 'e2e-header.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(HEADER_SVG) });
      await page.selectOption('#asset-target', 'headerGraphic');
      await page.getByRole('button', { name: 'Upload', exact: true }).click();
      await expectStatus(page, /Uploaded assets\/e2e-header\.svg/);
      await expect(page.getByLabel('Card header art')).toHaveValue('assets/e2e-header.svg');
      await shot(page, 'builder-images');

      // ---- a colour: the page background, light and dark
      await page.getByRole('tab', { name: 'Pages' }).click();
      for (const mode of ['light', 'dark']) {
        const field = page.getByLabel(`Page background (${mode})`, { exact: true });
        await field.fill(PAGE_BG);
        await field.press('Tab');
      }
      await expect(page.getByText('Unsaved', { exact: true })).toBeVisible();
      await expect(frame.locator(`[id="${MARK}"]`)).toHaveCount(1, { timeout: 30000 });
      await shot(page, 'builder-pages');
      await page.getByRole('button', { name: 'عربي' }).click();
      await page.getByRole('button', { name: 'Dark', exact: true }).click();
      await page.getByRole('button', { name: 'Phone', exact: true }).click();
      await expect(frame.locator('html')).toHaveAttribute('dir', 'rtl', { timeout: 30000 });
      await shot(page, 'builder-preview-ar-dark-phone');

      // ---- publish
      await page.getByRole('button', { name: 'Publish', exact: true }).click();
      await expectStatus(page, /Published version/);

      // ---- the test app's default
      await page.goto(admin('/themes'));
      const row = page.getByTestId(`client-default-${clientId}`);
      await row.locator('select').selectOption(THEME_ID);
      await row.getByRole('button', { name: 'Save' }).click();
      await expectStatus(page, /App default saved/);

      // ---- the app's sign-in pages wear it, in English and Arabic, for a visitor
      // who isn't signed in (the admin's own session would sign straight in)
      const visitor = await browser.newContext();
      try {
        const vpage = await visitor.newPage();
        await expectSignInThemed(vpage, clientId, 'en');
        await expectSignInThemed(vpage, clientId, 'ar');

        // ---- a per-call theme wins over the app default; an unknown one falls back to it
        await vpage.goto(authorizeUrl(clientId, { theme: 'zujaj' }));
        await expect(vpage.locator('html')).toHaveAttribute('data-theme', 'zujaj');
        await vpage.goto(authorizeUrl(clientId, { theme: 'no-such-theme' }));
        await expect(vpage.locator('html')).toHaveAttribute('data-theme', THEME_ID);
      } finally {
        await visitor.close();
      }

      // ---- a theme in use cannot be deleted
      await page.goto(admin('/themes'));
      await expect(page.getByTestId(`theme-${THEME_ID}`).getByRole('button', { name: 'Delete' })).toBeDisabled();
    } finally {
      // ---- restore: no app default, no test app, no test theme
      if (clientId) {
        await page.goto(admin('/themes'));
        const row = page.getByTestId(`client-default-${clientId}`);
        if (await row.count()) {
          await row.locator('select').selectOption('');
          await row.getByRole('button', { name: 'Save' }).click();
          await expectStatus(page, /App default saved/).catch(() => {});
        }
        await page.goto(admin('/clients'));
        const clientRow = page.locator('tr', { hasText: CLIENT_NAME });
        if (await clientRow.count()) {
          await clientRow.getByTitle('Delete').click();
          await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
          await expect(clientRow).toHaveCount(0, { timeout: 20000 });
        }
      }
      if (themeCreated) {
        await page.goto(admin('/themes'));
        const card = page.getByTestId(`theme-${THEME_ID}`);
        await card.getByRole('button', { name: 'Delete' }).click();
        // In-app confirmation; the theme moves to Recently deleted
        await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
        await expect(card).toHaveCount(0, { timeout: 20000 });
      }
    }

    // ---- after cleanup the app and the theme are gone
    await page.goto(admin('/themes'));
    await expect(page.getByTestId(`theme-${THEME_ID}`)).toHaveCount(0);
    const list = await (await page.request.get(`${TEST_URLS.authServer}/themes`)).json();
    expect(list.themes.map((t: { id: string }) => t.id)).not.toContain(THEME_ID);
  });
});
