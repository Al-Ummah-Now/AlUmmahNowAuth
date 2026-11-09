/**
 * E2E Test: Registration when the verification code can't be sent
 *
 * If sendCode fails (Resend rejects the address, Resend is down, rate limit,
 * missing secret), the user must stay on the Register form, see a clear error,
 * and be able to fix the address and resubmit. Previously the error escaped to
 * the issuer and bounced the browser to the client app with
 * ?error=server_error ("Sign-in did not finish").
 */

import { test, expect, type Page } from '@playwright/test';
import { expectSignInPage } from '../../fixtures/auth';
import { TEST_URLS, TEST_USERS } from '../../utils/test-data';
import { fillSecret } from '../../utils/secret-input';
import { TEST_PASSWORD } from '../../utils/test-credentials';

// Signs in with the test password / one-time codes (or sends test secrets in headers):
// traces would record them, so none for this file. See e2e/utils/secret-input.ts.
test.use({ trace: 'off' });
// Resend refuses to deliver to the reserved example.com domain
const UNDELIVERABLE_EMAIL = 'x@example.com';
const SEND_FAILED_MESSAGE = "We couldn't send the code to this email";

async function openRegisterForm(page: Page) {
  await page.goto(TEST_URLS.profileApp);
  await page.waitForLoadState('domcontentloaded');
  await expectSignInPage(page);
  await expect(page).toHaveURL(new RegExp(TEST_URLS.authServer));
  await page.click('a:has-text("Register")');
  await expect(page.locator('input[type="email"]')).toBeVisible();
}

async function submitRegistration(page: Page, email: string) {
  await page.fill('input[type="email"]', email);
  const passwordFields = page.locator('input[type="password"]');
  await fillSecret(passwordFields.nth(0), TEST_PASSWORD);
  await fillSecret(passwordFields.nth(1), TEST_PASSWORD);
  await page.click('button:has-text("Continue")');
}

test.describe('Registration: code delivery failure', () => {
  test.setTimeout(60000);

  test('stays on the form with an error, then accepts a corrected address', async ({ page }) => {
    await openRegisterForm(page);
    await submitRegistration(page, UNDELIVERABLE_EMAIL);

    // Same form, with the error, still on the auth server (no server_error redirect)
    await expect(page.getByText(SEND_FAILED_MESSAGE)).toBeVisible({ timeout: 20000 });
    await expect(page).toHaveURL(new RegExp(TEST_URLS.authServer));
    expect(new URL(page.url()).searchParams.get('error')).toBeNull();
    await expect(page.locator('input[type="email"]')).toHaveValue(UNDELIVERABLE_EMAIL);
    await expect(page.locator('input[name="code"]')).toHaveCount(0);

    // Fix the address and resubmit: the code screen appears
    await submitRegistration(page, TEST_USERS.user().email);
    await expect(page.locator('input[name="code"]')).toBeVisible({ timeout: 20000 });
    await expect(page.getByText(SEND_FAILED_MESSAGE)).toHaveCount(0);
  });
});
