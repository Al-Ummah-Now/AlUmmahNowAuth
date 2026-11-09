/**
 * "If you are signed in, you are signed in" for the profile app and the auth admin.
 *
 *   - signed in once: both apps open with no prompt (no landing page, no form)
 *   - two accounts: each app's account menu lists both, and switching works
 *   - after single sign-out: both apps show the sign-in form
 *
 * Runs against the deployed apps (QA in CI). Needs TEST_PROMOTE_SECRET to make
 * the two users admins (the auth admin only lets admins in).
 */
import { test, expect, type Browser, type Locator, type Page } from '@playwright/test';
import { register, expectSignInPage } from '../../fixtures/auth';
import { TEST_URLS, generateTestEmail } from '../../utils/test-data';

const PASSWORD = 'TestPassword123!'; // same as fixtures/auth.ts
const profile = () => new URL(TEST_URLS.profileApp).origin;
const admin = () => new URL(TEST_URLS.adminDashboard).origin;

/** Registers `email` in a throwaway browser context (so it does not sign in the test's browser). */
async function registerElsewhere(browser: Browser, email: string) {
  const context = await browser.newContext();
  await register(await context.newPage(), email);
  await context.close();
}

async function promote(page: Page, email: string) {
  const res = await page.request.post(`${TEST_URLS.authServer}/test/promote/${encodeURIComponent(email)}`, {
    headers: {
      'X-Test-Secret': process.env.TEST_PROMOTE_SECRET!,
      'X-E2E-Secret': process.env.E2E_CODE_SINK_SECRET ?? '',
    },
  });
  expect(res.ok(), `promote ${email}: ${res.status()}`).toBe(true);
}

/** Fills the auth server's sign-in form the browser is on. */
async function submitSignIn(page: Page, email: string) {
  await expectSignInPage(page);
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('form[data-component="form"] button[data-component="button"]');
}

/** Every time the browser lands on the auth server's sign-in form. */
function trackSignInForm(page: Page): string[] {
  const visits: string[] = [];
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame() && new URL(frame.url()).pathname.startsWith('/password/')) visits.push(frame.url());
  });
  return visits;
}

/**
 * Clicks an account to switch to and waits until the app has signed in again:
 * switching is a fetch to auth's /session/switch, then a silent /login?prompt=none
 * round trip that ends at the app's OAuth callback. The old page (with the old
 * account) stays visible until then, so asserting right after the click races it.
 */
async function switchTo(page: Page, item: Locator, callback: URL) {
  const done = page.waitForResponse(
    (r) => {
      const u = new URL(r.url());
      return u.origin === callback.origin && u.pathname === callback.pathname && r.request().method() === 'GET';
    },
    { timeout: 30000 }
  );
  await item.click();
  const res = await done;
  expect(res.status(), `${callback.href} completes the switch`).toBe(302);
  await page.waitForLoadState('domcontentloaded');
}

async function profileEmail(page: Page) {
  await expect(page.locator('#loggedInView')).toBeVisible({ timeout: 20000 });
  return (await page.locator('#userEmail').textContent())?.trim();
}

/** Opens the profile account menu and returns the listed emails (waits for auth's list). */
async function profileMenu(page: Page, expected: number) {
  await page.locator('#accountTrigger').click();
  const items = page.locator('#accountsList [data-testid="account-item"]');
  await expect(items).toHaveCount(expected, { timeout: 15000 });
  return items;
}

async function adminMenu(page: Page, expected: number) {
  await page.getByTestId('account-menu').click();
  const items = page.getByTestId('account-item');
  await expect(items).toHaveCount(expected, { timeout: 15000 });
  return items;
}

test.describe('Signed in once, signed in everywhere (profile + auth admin)', () => {
  test.setTimeout(240000);

  test('no prompt when signed in, both accounts listed and switchable, sign-in form after single sign-out', async ({ page, browser }) => {
    test.skip(!process.env.TEST_PROMOTE_SECRET, 'TEST_PROMOTE_SECRET not set: cannot create admin users');

    const alice = generateTestEmail('signedin-a');
    const bob = generateTestEmail('signedin-b');
    await registerElsewhere(browser, alice);
    await registerElsewhere(browser, bob);
    await promote(page, alice);
    await promote(page, bob);

    // 1. Sign in once, on the profile app (no landing page: straight to the form)
    await page.goto(TEST_URLS.profileApp);
    await submitSignIn(page, alice);
    expect(await profileEmail(page)).toBe(alice);

    // 2. The auth admin opens with no prompt
    const forms = trackSignInForm(page);
    await page.goto(TEST_URLS.adminDashboard);
    await expect(page.locator('a:has-text("Users")')).toBeVisible({ timeout: 20000 });
    expect(new URL(page.url()).origin).toBe(admin());
    await page.goto(TEST_URLS.profileApp);
    expect(await profileEmail(page)).toBe(alice);
    expect(forms, 'no sign-in form after the first sign-in').toEqual([]);

    // 3. Add a second account from the profile menu (prompt=login shows the form)
    await profileMenu(page, 1);
    await page.locator('#addAccountBtn').click();
    await submitSignIn(page, bob);
    expect(await profileEmail(page)).toBe(bob);

    // 4. The profile menu lists both; switching back to Alice is silent
    const formsBefore = forms.length;
    let items = await profileMenu(page, 2);
    await expect(items.filter({ hasText: alice })).toHaveCount(1);
    await expect(items.filter({ hasText: bob })).toHaveCount(1);
    await switchTo(page, items.filter({ hasText: alice }), new URL('/callback', profile()));
    await expect(page.locator('#userEmail')).toHaveText(alice, { timeout: 20000 });
    expect(forms.length, 'switching shows no form').toBe(formsBefore);

    // 5. The auth admin: signed in as auth's active account (Alice), menu lists both, switch to Bob
    await page.goto(TEST_URLS.adminDashboard);
    await expect(page.locator('a:has-text("Users")')).toBeVisible({ timeout: 20000 });
    items = await adminMenu(page, 2);
    await expect(items.filter({ hasText: alice })).toContainText('Active');
    await switchTo(page, items.filter({ hasText: bob }), new URL('/auth/callback', admin()));
    await expect(page.locator('a:has-text("Users")')).toBeVisible({ timeout: 20000 });
    expect(new URL(page.url()).origin).toBe(admin());
    items = await adminMenu(page, 2);
    await expect(items.filter({ hasText: bob })).toContainText('Active');
    expect(forms.length, 'switching shows no form').toBe(formsBefore);

    // ...and the profile menu (auth's list) now marks Bob as the active account
    await page.goto(TEST_URLS.profileApp);
    items = await profileMenu(page, 2);
    await expect(items.filter({ hasText: bob })).toHaveClass(/active/);

    // 6. Single sign-out: every app shows the sign-in form again
    await page.goto(`${profile()}/logout`);
    await expectSignInPage(page, 30000);
    await page.goto(TEST_URLS.profileApp);
    await expectSignInPage(page);
    await page.goto(TEST_URLS.adminDashboard);
    await expectSignInPage(page);
    const authSession = (await page.context().cookies(TEST_URLS.authServer)).find((c) => c.name === '__session');
    expect(authSession).toBeUndefined();
  });
});
