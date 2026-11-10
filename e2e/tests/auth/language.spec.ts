/**
 * Every sign-in page is English unless the link says ?lang=ar (Auth #261,
 * openauth 1.0.30), even in a browser that prefers Arabic; Arabic pages are
 * right to left; and the deployed Worker keeps each concurrent request's own
 * language (the theme and locale used to live in a global shared by every
 * request in an isolate, so Arabic pages came out dir="ltr" under load).
 */
import { test, expect, type Page } from '@playwright/test';
import { register } from '../../fixtures/auth';
import { TEST_URLS, generateTestEmail } from '../../utils/test-data';

// Registers with the test password: traces would record it. See e2e/utils/secret-input.ts.
test.use({ trace: 'off', locale: 'ar-SA' }); // Accept-Language: ar-SA

const ARABIC_CONTINUE = 'متابعة';
// The page links are relative ("register?auth_flow=…"), so match on the start of href.
const LINK = (page: 'authorize' | 'register' | 'change') => `a[href^="${page}?"]`;

/** The profile app's sign-in page on the auth server; returns its URL (with auth_flow). */
async function openSignIn(page: Page): Promise<string> {
  await page.goto(TEST_URLS.profileApp);
  await expect(page).toHaveURL(new RegExp(`${TEST_URLS.authServer}/password/authorize`));
  await expect(page.locator('input[type="password"]')).toBeVisible();
  return page.url();
}

async function expectEnglish(page: Page) {
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await expect(page.locator('form[data-component="form"] button[data-component="button"]').first()).toHaveText('Continue');
}

async function expectArabic(page: Page) {
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('form[data-component="form"] button[data-component="button"]').first()).toHaveText(ARABIC_CONTINUE);
}

function withLang(url: string, lang: string): string {
  const u = new URL(url);
  u.searchParams.set('lang', lang);
  return u.toString();
}

test.describe('Sign-in language', () => {
  test.setTimeout(90000);

  test('an Arabic browser gets English on sign-in, register, forgot password and the code screen', async ({ page }) => {
    expect(await page.evaluate(() => navigator.language)).toBe('ar-SA');
    await openSignIn(page);
    await expectEnglish(page);

    await page.click(LINK('register'));
    await expect(page).toHaveURL(/\/password\/register/);
    await expect(page.locator('input[name="repeat"]')).toBeVisible();
    await expectEnglish(page);

    await page.click(LINK('authorize'));
    await page.click(LINK('change'));
    await expect(page).toHaveURL(/\/password\/change/);
    await expectEnglish(page);

    // Unknown address: the same code screen a real account gets, with no email sent
    await page.fill('input[type="email"]', generateTestEmail('lang-en-code'));
    await page.click('button:has-text("Continue")');
    await expect(page.locator('input[name="code"]')).toBeVisible({ timeout: 10000 });
    await expectEnglish(page);
    await expect(page.locator('input[name="code"]')).toHaveAttribute('placeholder', 'Code (check your inbox)');
  });

  test('?lang=ar gives Arabic, right to left, on every sign-in page, and the links keep it', async ({ page }) => {
    await page.goto(withLang(await openSignIn(page), 'ar'));
    await expectArabic(page);

    await page.click(LINK('register'));
    await expect(page).toHaveURL(/\/password\/register\?.*lang=ar/);
    await expectArabic(page);

    await page.click(LINK('authorize'));
    await expect(page).toHaveURL(/\/password\/authorize\?.*lang=ar/);
    await page.click(LINK('change'));
    await expect(page).toHaveURL(/\/password\/change\?.*lang=ar/);
    await expectArabic(page);

    await page.fill('input[type="email"]', generateTestEmail('lang-ar-code'));
    await page.locator('form[data-component="form"] button[data-component="button"]').first().click();
    await expect(page.locator('input[name="code"]')).toBeVisible({ timeout: 10000 });
    await expectArabic(page);
    // The code field's label is Arabic too, not the English "check your inbox" copy
    const placeholder = await page.locator('input[name="code"]').getAttribute('placeholder');
    expect(placeholder).toContain('الرمز');
    expect(placeholder).not.toContain('Code');
  });

  test('concurrent English and Arabic requests to the deployed Worker each keep their own language', async ({ page }) => {
    const signIn = await openSignIn(page);
    const urls = Array.from({ length: 24 }, (_, i) => (i % 2 ? withLang(signIn, 'ar') : signIn));
    const pages = await Promise.all(
      urls.map(async (url) => {
        const res = await page.request.get(url, { headers: { 'accept-language': 'ar-SA,ar;q=0.9' } });
        expect(res.status()).toBe(200);
        return res.text();
      })
    );
    pages.forEach((html, i) => {
      const tag = html.match(/<html[^>]*>/)?.[0] ?? '';
      if (i % 2) {
        expect(tag, `request ${i} asked for Arabic`).toContain('lang="ar"');
        expect(tag, `request ${i} asked for Arabic`).toContain('dir="rtl"');
      } else {
        expect(tag, `request ${i} asked for no language`).toContain('lang="en"');
        expect(tag, `request ${i} asked for no language`).toContain('dir="ltr"');
      }
    });
  });

  test('the profile app is English for an Arabic browser and Arabic for ?lang=ar', async ({ page }) => {
    await register(page, generateTestEmail('lang-profile'));
    await page.goto(TEST_URLS.profileApp);
    await expect(page.locator('#loggedInView')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');

    await page.goto(`${TEST_URLS.profileApp}/?lang=ar`);
    await expect(page.locator('#loggedInView')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  });
});
