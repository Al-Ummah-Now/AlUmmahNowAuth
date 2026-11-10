/**
 * E2E Test: Forgot Password Flow
 *
 * Tests the password reset/change flow in OpenAuth PasswordUI
 */

import { test, expect, type Page } from '@playwright/test';
import { register, expectSignInPage } from '../../fixtures/auth';
import { TEST_USERS, TEST_URLS } from '../../utils/test-data';
import { setupEmailInterception, sinkHasCode } from '../../utils/email-interceptor';
import { ResendTestClient } from '../../utils/resend-client';
import { fillSecret } from '../../utils/secret-input';
import { TEST_PASSWORD, NEW_TEST_PASSWORD as NEW_PASSWORD } from '../../utils/test-credentials';

// Signs in with the test password / one-time codes (or sends test secrets in headers):
// traces would record them, so none for this file. See e2e/utils/secret-input.ts.
test.use({ trace: 'off' });

test.describe('Forgot Password Flow', () => {
  // Increase timeout for forgot password tests - these are complex multi-step flows
  // involving registration, logout, password reset, verification codes, and re-login
  test.setTimeout(120000);

  test('unknown email reaches the code screen without leaving the auth page or sending an email', async ({ page }) => {
    // Never registered: this is exactly what a mistyped/unknown address looks like.
    // Previously sendCode threw for unknown emails, which bounced the browser back to
    // the client app with ?error=server_error and revealed that the account did not exist.
    const unknownEmail = TEST_USERS.user().email;

    await page.goto(TEST_URLS.profileApp);
    await page.waitForLoadState('domcontentloaded');
    await expectSignInPage(page);
    await expect(page).toHaveURL(new RegExp(TEST_URLS.authServer));

    await page.click('a:has-text("Forgot password")');
    await expect(page.locator('input[type="email"]')).toBeVisible();
    await page.fill('input[type="email"]', unknownEmail);
    await page.click('button:has-text("Continue")');

    // Same "enter code" screen a real account gets (no enumeration)
    await expect(page.locator('input[name="code"]')).toBeVisible({ timeout: 10000 });
    await expect(page).toHaveURL(new RegExp(TEST_URLS.authServer));
    expect(new URL(page.url()).searchParams.get('error')).toBeNull();

    // A wrong code keeps the user on the code screen instead of erroring out
    await page.fill('input[name="code"]', '000000');
    await page.click('button:has-text("Continue")');
    await expect(page.locator('input[name="code"]')).toBeVisible({ timeout: 10000 });
    await expect(page).toHaveURL(new RegExp(TEST_URLS.authServer));

    // No code may have been sent to the unknown address
    const sinkResult = await sinkHasCode(unknownEmail);
    if (sinkResult !== null) {
      expect(sinkResult).toBe(false);
      return;
    }
    const resendApiKey = process.env.RESEND_API_KEY || process.env.E2E_RESEND_API_KEY;
    test.skip(!resendApiKey, 'RESEND_API_KEY not set - cannot verify that no email was sent');
    const resend = new ResendTestClient(resendApiKey!);
    const email = await resend.getVerificationEmail(unknownEmail, 4, 1500);
    expect(email).toBeNull();
  });

  test('should complete forgot password flow and login with new password', async ({ page }) => {
    const testUser = TEST_USERS.user();

    // Step 1: Register a new user first
    await register(page, testUser.email);

    // Step 2: Log out
    await page.goto(TEST_URLS.profileApp);
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('#loggedInView')).toBeVisible({ timeout: 15000 });
    // Use .first() to handle potential duplicate matches (account switcher also has "Sign out of all accounts")
    const signOutBtn1 = page.locator('#loggedInView button:has-text("Sign Out")').first();
    await expect(signOutBtn1).toBeVisible({ timeout: 5000 });
    await signOutBtn1.click();
    await page.waitForLoadState('domcontentloaded');
    await expectSignInPage(page);

    // Step 3: Navigate to auth server login page
    await expect(page).toHaveURL(new RegExp(TEST_URLS.authServer));

    // Step 4: Click "Forgot password" link
    await page.click('a:has-text("Forgot password")');

    // Set up email interception for the reset code
    const emailInterceptor = setupEmailInterception();

    // Step 5: Enter email for password reset
    await expect(page.locator('input[type="email"]')).toBeVisible();
    await page.fill('input[type="email"]', testUser.email);
    await page.click('button:has-text("Continue")');

    // Step 6: Wait for verification code input
    await expect(page.locator('input[name="code"]')).toBeVisible({ timeout: 10000 });

    // Step 7: Get verification code from auth server test endpoint
    const resetCode = await emailInterceptor.getLastLoginCode(testUser.email);

    if (!resetCode) {
      throw new Error('Failed to capture password reset verification code from email');
    }

    console.log(`Got reset code for ${testUser.email}: ${resetCode}`);

    // Step 8: Enter verification code with retry logic
    for (let attempt = 1; attempt <= 3; attempt++) {
      await fillSecret(page.locator('input[name="code"]').first(), resetCode);
      await page.waitForTimeout(100);

      const continueBtn = page.locator('button:has-text("Continue")');
      await expect(continueBtn).toBeEnabled({ timeout: 5000 });
      await continueBtn.click();

      // Check if password fields are now visible (code accepted)
      const passwordVisible = await page.locator('input[type="password"]').first().isVisible({ timeout: 8000 }).catch(() => false);
      if (passwordVisible) {
        break;
      }

      // If still on code page and not last attempt, retry
      const stillOnCodePage = await page.locator('input[name="code"]').isVisible().catch(() => false);
      if (stillOnCodePage && attempt < 3) {
        console.log(`Reset code submission attempt ${attempt} failed, retrying...`);
        continue;
      }
      if (attempt === 3 && !passwordVisible) {
        throw new Error(`Reset code submission failed after ${attempt} attempts. Page URL: ${page.url()}`);
      }
    }

    // Step 9: Enter new password
    await expect(page.locator('input[type="password"]').first()).toBeVisible({ timeout: 10000 });

    const passwordFields = page.locator('input[type="password"]');
    await fillSecret(passwordFields.nth(0), NEW_PASSWORD);
    await fillSecret(passwordFields.nth(1), NEW_PASSWORD); // Confirm password

    await page.click('button:has-text("Continue")');

    // Step 10: After password change, wait for either:
    // - Redirect to profile app (auto-login) OR
    // - Redirect to login page (manual login required)
    await page.waitForTimeout(2000); // Wait for redirect to complete

    // Check if we're on profile app (auto-logged in) or back to login page
    const currentUrl = page.url();
    const isOnProfileApp = currentUrl.includes('profile');

    if (!isOnProfileApp) {
      console.log('Password reset completed - redirected to login page, logging in with new password');

      // We're on the login page, need to log in with new password
      await expect(page.locator('input[type="email"]')).toBeVisible({ timeout: 5000 });
      await page.fill('input[type="email"]', testUser.email);
      await fillSecret(page.locator('input[type="password"]').first(), NEW_PASSWORD);
      await page.click('button:has-text("Continue")');

      // Handle verification code if required
      const codeInput = page.locator('input[name="code"]');
      const needsVerificationCode = await codeInput.isVisible({ timeout: 3000 }).catch(() => false);

      if (needsVerificationCode) {
        const verificationCode = await emailInterceptor.getLastLoginCode(testUser.email);
        if (!verificationCode) {
          throw new Error('Failed to capture verification code during login with new password');
        }
        console.log(`Got login verification code for ${testUser.email}: ${verificationCode}`);
        await fillSecret(page.locator('input[name="code"]').first(), verificationCode);
        await page.click('button:has-text("Continue")');
      }

      // Wait for redirect to profile app
      await expect(page).toHaveURL(TEST_URLS.profileApp, { timeout: 15000 });
    } else {
      console.log('Password reset completed - auto-logged in');
    }

    // Wait for network to be idle - OAuth callback performs async token exchange
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('#loggedInView')).toBeVisible({ timeout: 20000 });

    // Step 11: Log out to verify we can log back in with the NEW password
    // Wait for button to be visible and stable before clicking
    const signOutBtn = page.locator('#loggedInView button:has-text("Sign Out")').first();
    await expect(signOutBtn).toBeVisible({ timeout: 10000 });
    await signOutBtn.click();
    await expectSignInPage(page);

    // Step 12: Log in again with the NEW password to verify it works
    await expect(page).toHaveURL(new RegExp(TEST_URLS.authServer));

    await page.fill('input[type="email"]', testUser.email);
    await fillSecret(page.locator('input[type="password"]').first(), NEW_PASSWORD);
    await page.click('button:has-text("Continue")');

    // Handle verification code if required during login with new password
    const loginCodeInput = page.locator('input[name="code"]');
    const needsLoginVerificationCode = await loginCodeInput.isVisible({ timeout: 3000 }).catch(() => false);

    if (needsLoginVerificationCode) {
      const loginVerificationCode = await emailInterceptor.getLastLoginCode(testUser.email);
      if (!loginVerificationCode) {
        throw new Error('Failed to capture verification code during login with new password');
      }
      console.log(`Got login verification code for ${testUser.email}: ${loginVerificationCode}`);
      await fillSecret(page.locator('input[name="code"]').first(), loginVerificationCode);
      await page.click('button:has-text("Continue")');
    }

    // Step 13: Should successfully log in with new password
    await expect(page).toHaveURL(TEST_URLS.profileApp, { timeout: 15000 });
    // Wait for network to be idle - OAuth callback performs async token exchange
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('#loggedInView')).toBeVisible({ timeout: 20000 });

    console.log('Successfully logged in with NEW password!');
  });

  test('should reject login with old password after reset', async ({ page }) => {
    const testUser = TEST_USERS.user();

    // Step 1: Register a new user
    await register(page, testUser.email);

    // Step 2: Log out
    await page.goto(TEST_URLS.profileApp);
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await expect(page.locator('#loggedInView')).toBeVisible({ timeout: 20000 });
    const signOutBtn2 = page.locator('#loggedInView button:has-text("Sign Out")').first();
    await expect(signOutBtn2).toBeVisible({ timeout: 5000 });
    await signOutBtn2.click();
    await expectSignInPage(page);

    // Step 3: Go through forgot password flow
    await expect(page).toHaveURL(new RegExp(TEST_URLS.authServer));
    await page.click('a:has-text("Forgot password")');

    const emailInterceptor = setupEmailInterception();

    await page.fill('input[type="email"]', testUser.email);
    await page.click('button:has-text("Continue")');

    await expect(page.locator('input[name="code"]')).toBeVisible({ timeout: 10000 });
    const resetCode = await emailInterceptor.getLastLoginCode(testUser.email);

    if (!resetCode) {
      throw new Error('Failed to capture password reset verification code');
    }

    // Enter verification code with retry logic
    for (let attempt = 1; attempt <= 3; attempt++) {
      await fillSecret(page.locator('input[name="code"]').first(), resetCode);
      await page.waitForTimeout(100);

      const continueBtn = page.locator('button:has-text("Continue")');
      await expect(continueBtn).toBeEnabled({ timeout: 5000 });
      await continueBtn.click();

      const passwordVisible = await page.locator('input[type="password"]').first().isVisible({ timeout: 8000 }).catch(() => false);
      if (passwordVisible) break;

      const stillOnCodePage = await page.locator('input[name="code"]').isVisible().catch(() => false);
      if (stillOnCodePage && attempt < 3) continue;
      if (attempt === 3 && !passwordVisible) {
        throw new Error(`Reset code submission failed after ${attempt} attempts`);
      }
    }

    // Enter new password
    const passwordFields = page.locator('input[type="password"]');
    await fillSecret(passwordFields.nth(0), NEW_PASSWORD);
    await fillSecret(passwordFields.nth(1), NEW_PASSWORD);
    await page.click('button:has-text("Continue")');

    // Wait for redirect to complete
    await page.waitForTimeout(2000);

    // Check if we're on profile app (auto-logged in) or back to login page
    const currentUrl = page.url();
    const isOnProfileApp = currentUrl.includes('profile');

    if (!isOnProfileApp) {
      console.log('Password reset completed - redirected to login page, logging in with new password');

      // We're on the login page, need to log in with new password
      await expect(page.locator('input[type="email"]')).toBeVisible({ timeout: 5000 });
      await page.fill('input[type="email"]', testUser.email);
      await fillSecret(page.locator('input[type="password"]').first(), NEW_PASSWORD);
      await page.click('button:has-text("Continue")');

      // Handle verification code if required
      const codeInput = page.locator('input[name="code"]');
      const needsVerificationCode = await codeInput.isVisible({ timeout: 3000 }).catch(() => false);

      if (needsVerificationCode) {
        const verificationCode = await emailInterceptor.getLastLoginCode(testUser.email);
        if (!verificationCode) {
          throw new Error('Failed to capture verification code during login with new password');
        }
        await fillSecret(page.locator('input[name="code"]').first(), verificationCode);
        await page.click('button:has-text("Continue")');
      }

      // Wait for redirect to profile app
      await expect(page).toHaveURL(TEST_URLS.profileApp, { timeout: 15000 });
    }

    // Wait for network to be idle - OAuth callback performs async token exchange
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('#loggedInView')).toBeVisible({ timeout: 20000 });

    // Log out to test old password rejection
    const signOutBtn3 = page.locator('#loggedInView button:has-text("Sign Out")').first();
    await expect(signOutBtn3).toBeVisible({ timeout: 5000 });
    await signOutBtn3.click();
    await expectSignInPage(page);

    // Step 4: Try to log in with OLD password - should fail
    await expect(page).toHaveURL(new RegExp(TEST_URLS.authServer));

    await page.fill('input[type="email"]', testUser.email);
    await fillSecret(page.locator('input[type="password"]').first(), TEST_PASSWORD); // OLD password
    await page.click('button:has-text("Continue")');

    // Should stay on auth page with error (not redirect to profile)
    // Wait a bit to ensure we're not redirecting
    await page.waitForTimeout(2000);
    await expect(page).toHaveURL(new RegExp(TEST_URLS.authServer));

    // Look for error message about invalid password or still on login page
    const stillOnLoginPage = await page.locator('input[type="password"]').isVisible();
    const errorVisible = await page.locator('text=invalid').isVisible() ||
                         await page.locator('text=incorrect').isVisible() ||
                         await page.locator('[class*="error"]').isVisible();

    // Either error is shown or we're still on login page (not redirected to profile)
    expect(stillOnLoginPage || errorVisible).toBe(true);

    // Verify we can log in with NEW password
    await page.fill('input[type="email"]', testUser.email);
    await fillSecret(page.locator('input[type="password"]').first(), NEW_PASSWORD); // NEW password
    await page.click('button:has-text("Continue")');

    // Handle verification code if required during login with new password
    const newPwdCodeInput = page.locator('input[name="code"]');
    const needsNewPwdVerificationCode = await newPwdCodeInput.isVisible({ timeout: 3000 }).catch(() => false);

    if (needsNewPwdVerificationCode) {
      const newPwdVerificationCode = await emailInterceptor.getLastLoginCode(testUser.email);
      if (!newPwdVerificationCode) {
        throw new Error('Failed to capture verification code during login with new password');
      }
      await fillSecret(page.locator('input[name="code"]').first(), newPwdVerificationCode);
      await page.click('button:has-text("Continue")');
    }

    // Should successfully log in with new password
    await expect(page).toHaveURL(TEST_URLS.profileApp, { timeout: 15000 });
    // Wait for network to be idle - OAuth callback performs async token exchange
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('#loggedInView')).toBeVisible({ timeout: 20000 });
  });

  test('should show error for invalid reset code', async ({ page }) => {
    const testUser = TEST_USERS.user();

    // Register user first
    await register(page, testUser.email);

    // Log out
    await page.goto(TEST_URLS.profileApp);
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await expect(page.locator('#loggedInView')).toBeVisible({ timeout: 20000 });
    const signOutBtn4 = page.locator('#loggedInView button:has-text("Sign Out")').first();
    await expect(signOutBtn4).toBeVisible({ timeout: 5000 });
    await signOutBtn4.click();
    await expectSignInPage(page);

    // Start forgot password flow
    await page.click('a:has-text("Forgot password")');

    await page.fill('input[type="email"]', testUser.email);
    await page.click('button:has-text("Continue")');

    await expect(page.locator('input[name="code"]')).toBeVisible({ timeout: 10000 });

    // Enter wrong code
    await page.fill('input[name="code"]', '000000');
    await page.click('button:has-text("Continue")');

    // Should show error and stay on code page
    await page.waitForTimeout(1000);

    // Should either show error or stay on code input page
    const stillOnCodePage = await page.locator('input[name="code"]').isVisible();
    const hasError = await page.locator('text=invalid').isVisible() ||
                     await page.locator('text=incorrect').isVisible() ||
                     await page.locator('[class*="error"]').isVisible();

    expect(stillOnCodePage || hasError).toBe(true);
  });

  /** From a signed-in profile page: sign out, ask for a reset code, and return it (code screen shown). */
  async function requestResetCode(page: Page, email: string): Promise<string> {
    await page.goto(TEST_URLS.profileApp);
    await expect(page.locator('#loggedInView')).toBeVisible({ timeout: 20000 });
    await page.locator('#loggedInView button:has-text("Sign Out")').first().click();
    await expectSignInPage(page);
    return requestResetCodeFromSignIn(page, email);
  }

  /** From the sign-in form: ask for a reset code and return it (code screen shown). */
  async function requestResetCodeFromSignIn(page: Page, email: string): Promise<string> {
    await page.click('a:has-text("Forgot password")');
    await page.fill('input[type="email"]', email);
    await page.click('button:has-text("Continue")');
    await expect(page.locator('input[name="code"]')).toBeVisible({ timeout: 10000 });
    const code = await setupEmailInterception().getLastLoginCode(email);
    if (!code) throw new Error(`No reset code reached the sink for ${email}`);
    return code;
  }

  async function submitCode(page: Page, code: string) {
    await fillSecret(page.locator('input[name="code"]').first(), code);
    await page.click('button:has-text("Continue")');
    await page.waitForLoadState('domcontentloaded');
  }

  test('after 5 wrong codes even the right code is refused (AU-2)', async ({ page }) => {
    const testUser = TEST_USERS.user();
    await register(page, testUser.email);
    const code = await requestResetCode(page, testUser.email);
    const wrong = code === '000000' ? '000001' : '000000';

    for (let i = 1; i <= 5; i++) {
      await submitCode(page, wrong);
      await expect(page.locator('input[name="code"]'), `wrong code ${i} keeps the code screen`).toBeVisible({ timeout: 10000 });
      await expect(page.locator('input[name="repeat"]')).toHaveCount(0);
    }

    // The code is used up: the right one no longer opens the new-password step
    await submitCode(page, code);
    await expect(page.locator('input[name="code"]')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('input[name="repeat"]')).toHaveCount(0);
    await expect(page.locator('body')).toContainText('Request a new code');
  });

  test('a reset in another browser ends this browser\'s sign-in (#265)', async ({ page, browser }) => {
    const testUser = TEST_USERS.user();
    await register(page, testUser.email);
    await page.goto(TEST_URLS.profileApp);
    await expect(page.locator('#loggedInView')).toBeVisible({ timeout: 20000 });

    // Baseline: without its own session, the profile app is signed in again silently
    // by this browser's Al Ummah Now sign-in (no form)
    await page.context().clearCookies({ name: 'profile_session' });
    await page.goto(TEST_URLS.profileApp);
    await expect(page.locator('#loggedInView')).toBeVisible({ timeout: 20000 });

    // Another browser resets the password
    const other = await browser.newContext();
    try {
      const otherPage = await other.newPage();
      await otherPage.goto(TEST_URLS.profileApp);
      await expectSignInPage(otherPage);
      const code = await requestResetCodeFromSignIn(otherPage, testUser.email);
      await submitCode(otherPage, code);
      const passwordFields = otherPage.locator('input[type="password"]');
      await expect(passwordFields.nth(1)).toBeVisible({ timeout: 10000 });
      await fillSecret(passwordFields.nth(0), NEW_PASSWORD);
      await fillSecret(passwordFields.nth(1), NEW_PASSWORD);
      await otherPage.click('button:has-text("Continue")');
      await expect(otherPage.locator('input[name="repeat"]')).toHaveCount(0, { timeout: 15000 });
    } finally {
      await other.close();
    }

    // This browser's Al Ummah Now sign-in is gone: the profile app needs the form now
    await page.context().clearCookies({ name: 'profile_session' });
    await page.goto(TEST_URLS.profileApp);
    await expectSignInPage(page);
    await expect(page.locator('#loggedInView')).toHaveCount(0);
  });
});
