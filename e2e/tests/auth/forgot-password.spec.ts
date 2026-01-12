/**
 * E2E Test: Forgot Password Flow
 *
 * Tests the password reset/change flow in OpenAuth PasswordUI
 */

import { test, expect } from '@playwright/test';
import { register } from '../../fixtures/auth';
import { TEST_USERS, TEST_URLS } from '../../utils/test-data';
import { setupEmailInterception } from '../../utils/email-interceptor';

// Test password for all E2E test users
const TEST_PASSWORD = 'TestPassword123!';
const NEW_PASSWORD = 'NewTestPassword456!';

test.describe('Forgot Password Flow', () => {
  test('should complete forgot password flow and login with new password', async ({ page }) => {
    const testUser = TEST_USERS.user();

    // Step 1: Register a new user first
    await register(page, testUser.email);

    // Step 2: Log out
    await page.goto(TEST_URLS.profileApp);
    await expect(page.locator('#loggedInView')).toBeVisible();
    // Use .first() to handle potential duplicate matches (account switcher also has "Sign out of all accounts")
    const signOutBtn1 = page.locator('#loggedInView button:has-text("Sign Out")').first();
    await expect(signOutBtn1).toBeVisible({ timeout: 5000 });
    await signOutBtn1.click();
    await expect(page.locator('#loggedOutView')).toBeVisible();

    // Step 3: Navigate to auth server login page
    await page.locator('#loggedOutView button:has-text("Sign In")').click();
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

    // Step 8: Enter verification code
    await page.fill('input[name="code"]', resetCode);
    await page.click('button:has-text("Continue")');

    // Step 9: Enter new password
    await expect(page.locator('input[type="password"]').first()).toBeVisible({ timeout: 10000 });

    const passwordFields = page.locator('input[type="password"]');
    await passwordFields.nth(0).fill(NEW_PASSWORD);
    await passwordFields.nth(1).fill(NEW_PASSWORD); // Confirm password

    await page.click('button:has-text("Continue")');

    // Step 10: After password change, OpenAuth 1.0.1+ auto-logs in the user
    // Wait for redirect to profile app (successful auto-login)
    await expect(page).toHaveURL(TEST_URLS.profileApp, { timeout: 15000 });
    await expect(page.locator('#loggedInView')).toBeVisible({ timeout: 10000 });

    console.log('Password reset completed - user auto-logged in');

    // Step 11: Log out to verify we can log back in with the NEW password
    // Wait for button to be visible and stable before clicking
    const signOutBtn = page.locator('#loggedInView button:has-text("Sign Out")').first();
    await expect(signOutBtn).toBeVisible({ timeout: 10000 });
    await signOutBtn.click();
    await expect(page.locator('#loggedOutView')).toBeVisible();

    // Step 12: Log in with the NEW password
    await page.locator('#loggedOutView button:has-text("Sign In")').click();
    await expect(page).toHaveURL(new RegExp(TEST_URLS.authServer));

    await page.fill('input[type="email"]', testUser.email);
    await page.fill('input[type="password"]', NEW_PASSWORD);
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
      await page.fill('input[name="code"]', loginVerificationCode);
      await page.click('button:has-text("Continue")');
    }

    // Step 13: Should successfully log in with new password
    await expect(page).toHaveURL(TEST_URLS.profileApp, { timeout: 10000 });
    await expect(page.locator('#loggedInView')).toBeVisible();

    console.log('Successfully logged in with NEW password!');
  });

  test('should reject login with old password after reset', async ({ page }) => {
    const testUser = TEST_USERS.user();

    // Step 1: Register a new user
    await register(page, testUser.email);

    // Step 2: Log out
    await page.goto(TEST_URLS.profileApp);
    await expect(page.locator('#loggedInView')).toBeVisible({ timeout: 10000 });
    const signOutBtn2 = page.locator('#loggedInView button:has-text("Sign Out")').first();
    await expect(signOutBtn2).toBeVisible({ timeout: 5000 });
    await signOutBtn2.click();
    await expect(page.locator('#loggedOutView')).toBeVisible();

    // Step 3: Go through forgot password flow
    await page.locator('#loggedOutView button:has-text("Sign In")').click();
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

    await page.fill('input[name="code"]', resetCode);
    await page.click('button:has-text("Continue")');

    // Enter new password
    const passwordFields = page.locator('input[type="password"]');
    await passwordFields.nth(0).fill(NEW_PASSWORD);
    await passwordFields.nth(1).fill(NEW_PASSWORD);
    await page.click('button:has-text("Continue")');

    // Wait for completion - OpenAuth 1.0.1+ auto-logs in the user after password change
    await expect(page).toHaveURL(TEST_URLS.profileApp, { timeout: 15000 });
    await expect(page.locator('#loggedInView')).toBeVisible({ timeout: 10000 });

    // Log out to test old password rejection
    const signOutBtn3 = page.locator('#loggedInView button:has-text("Sign Out")').first();
    await expect(signOutBtn3).toBeVisible({ timeout: 5000 });
    await signOutBtn3.click();
    await expect(page.locator('#loggedOutView')).toBeVisible();

    // Step 4: Try to log in with OLD password - should fail
    await page.locator('#loggedOutView button:has-text("Sign In")').click();
    await expect(page).toHaveURL(new RegExp(TEST_URLS.authServer));

    await page.fill('input[type="email"]', testUser.email);
    await page.fill('input[type="password"]', TEST_PASSWORD); // OLD password
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
    await page.fill('input[type="password"]', NEW_PASSWORD); // NEW password
    await page.click('button:has-text("Continue")');

    // Handle verification code if required during login with new password
    const newPwdCodeInput = page.locator('input[name="code"]');
    const needsNewPwdVerificationCode = await newPwdCodeInput.isVisible({ timeout: 3000 }).catch(() => false);

    if (needsNewPwdVerificationCode) {
      const newPwdVerificationCode = await emailInterceptor.getLastLoginCode(testUser.email);
      if (!newPwdVerificationCode) {
        throw new Error('Failed to capture verification code during login with new password');
      }
      await page.fill('input[name="code"]', newPwdVerificationCode);
      await page.click('button:has-text("Continue")');
    }

    // Should successfully log in with new password
    await expect(page).toHaveURL(TEST_URLS.profileApp, { timeout: 10000 });
    await expect(page.locator('#loggedInView')).toBeVisible();
  });

  test('should show error for invalid reset code', async ({ page }) => {
    const testUser = TEST_USERS.user();

    // Register user first
    await register(page, testUser.email);

    // Log out
    await page.goto(TEST_URLS.profileApp);
    await expect(page.locator('#loggedInView')).toBeVisible();
    const signOutBtn4 = page.locator('#loggedInView button:has-text("Sign Out")').first();
    await expect(signOutBtn4).toBeVisible({ timeout: 5000 });
    await signOutBtn4.click();
    await expect(page.locator('#loggedOutView')).toBeVisible();

    // Start forgot password flow
    await page.locator('#loggedOutView button:has-text("Sign In")').click();
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
});
