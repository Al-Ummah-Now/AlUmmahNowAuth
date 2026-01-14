/**
 * E2E Test: Full OAuth Flow Integration
 *
 * Tests the complete OAuth 2.0 authorization code flow from profile app
 * through auth server and back.
 */

import { test, expect } from '@playwright/test';
import { login, logout, register } from '../../fixtures/auth';
import { TEST_USERS, TEST_URLS } from '../../utils/test-data';
import { setupEmailInterception } from '../../utils/email-interceptor';

// Test password for all E2E test users
const TEST_PASSWORD = 'TestPassword123!';

test.describe('Full OAuth Flow', () => {
  test('should complete full OAuth authorization code flow', async ({
    page,
    context,
  }) => {
    const testUser = TEST_USERS.user();

    // Step 0: Pre-register the user so they exist in the system
    await register(page, testUser.email);

    // Logout from profile app
    await logout(page);

    // Clear ALL cookies (profile app AND auth server) to ensure fresh login flow
    // This is necessary because auth server maintains its own session
    await context.clearCookies();

    // Set up email interception to capture verification code
    const emailInterceptor = setupEmailInterception(page);

    // Step 1: Navigate to profile app (client)
    await page.goto(TEST_URLS.profileApp);
    await expect(page.locator('#loggedOutView')).toBeVisible();

    // Step 2: Initiate OAuth flow by clicking login
    await page.locator('#loggedOutView button:has-text("Sign In")').click();

    // Step 3: Verify redirect to authorization server
    // The auth server may use different URL patterns:
    // - /authorize with query params (standard OAuth)
    // - /password/authorize (password-based flow)
    await expect(page).toHaveURL(new RegExp(TEST_URLS.authServer));
    const currentUrl = page.url();
    // Verify we're on an authorization-related page
    expect(currentUrl).toMatch(/\/authorize|\/login|\/password/);

    // Step 4: User authenticates (email + password)
    await page.fill('input[type="email"]', testUser.email);
    await page.fill('input[type="password"]', TEST_PASSWORD);
    await page.click('button:has-text("Continue")');

    // Step 5: Handle verification code if required
    // Note: Verification code is typically only required for registration.
    // For returning users (already registered), password flow may skip verification.
    const codeInput = page.locator('input[name="code"]');
    const needsVerificationCode = await codeInput.isVisible({ timeout: 3000 }).catch(() => false);

    if (needsVerificationCode) {
      const verificationCode = await emailInterceptor.getLastLoginCode(testUser.email);
      if (!verificationCode) {
        throw new Error('Failed to capture verification code from email');
      }
      await page.fill('input[name="code"]', verificationCode);
      await page.click('button:has-text("Continue")');
    }

    // Step 6: Verify redirect back to profile app after successful auth
    // The auth flow may:
    // - Redirect to /callback with code, then to profile app (standard OAuth)
    // - Redirect directly to profile app (server-side token exchange)
    // Wait for either callback or direct redirect to profile app
    await expect(page).toHaveURL(new RegExp(`${TEST_URLS.profileApp}|/callback`), { timeout: 15000 });

    // If we're on callback, wait for redirect to profile app
    if (page.url().includes('/callback')) {
      const callbackUrl = page.url();
      expect(callbackUrl).toContain('code=');
      await expect(page).toHaveURL(TEST_URLS.profileApp, { timeout: 10000 });
    }

    // Step 7: Verify user is logged in and can access profile
    // Wait for page to fully load (JavaScript needs to initialize and toggle view visibility)
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('#loggedInView')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#userEmail')).toContainText(testUser.email);

    // Step 8: Verify session is maintained
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('#loggedInView')).toBeVisible({ timeout: 15000 });

    // Step 9: Test logout (token revocation)
    await logout(page);
    await expect(page.locator('#loggedOutView')).toBeVisible();
  });

  test('should handle OAuth error responses', async ({ page }) => {
    // Navigate to profile app with OAuth error
    await page.goto(`${TEST_URLS.profileApp}?error=access_denied`);

    // Verify error handling
    // Note: Implementation depends on how profile app handles OAuth errors
    await expect(page.locator('.error-message')).toBeVisible();
  });

  test('should maintain session across page reloads', async ({ page }) => {
    const testUser = TEST_USERS.user();

    // Login
    await login(page, testUser.email);

    // Verify logged in
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('#loggedInView')).toBeVisible({ timeout: 15000 });

    // Reload page
    await page.reload();

    // Verify still logged in
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('#loggedInView')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#userEmail')).toContainText(testUser.email);
  });

  test('should work across multiple browser tabs', async ({ context }) => {
    const testUser = TEST_USERS.user();

    // Create first tab and login
    const page1 = await context.newPage();
    await login(page1, testUser.email);
    await page1.waitForLoadState('domcontentloaded');
    await expect(page1.locator('#loggedInView')).toBeVisible({ timeout: 15000 });

    // Create second tab
    const page2 = await context.newPage();
    await page2.goto(TEST_URLS.profileApp);

    // Verify session shared across tabs
    await page2.waitForLoadState('domcontentloaded');
    await expect(page2.locator('#loggedInView')).toBeVisible({ timeout: 15000 });

    // Logout from first tab
    await logout(page1);

    // Verify logout affects second tab (may require reload)
    await page2.reload();
    await page2.waitForLoadState('domcontentloaded');
    await expect(page2.locator('#loggedOutView')).toBeVisible({ timeout: 15000 });

    await page1.close();
    await page2.close();
  });
});
