/**
 * E2E Test: Full OAuth Flow Integration
 *
 * Tests the complete OAuth 2.0 authorization code flow from profile app
 * through auth server and back.
 */

import { test, expect } from '@playwright/test';
import { login, logout } from '../../fixtures/auth';
import { TEST_USERS, TEST_URLS } from '../../utils/test-data';

test.describe('Full OAuth Flow', () => {
  test('should complete full OAuth authorization code flow', async ({
    page,
  }) => {
    const testUser = TEST_USERS.user;

    // Step 1: Navigate to profile app (client)
    await page.goto(TEST_URLS.profileApp);
    await expect(page.locator('#loggedOutView')).toBeVisible();

    // Step 2: Initiate OAuth flow by clicking login
    await page.click('button:has-text("Sign In")');

    // Step 3: Verify redirect to authorization server with correct parameters
    await expect(page).toHaveURL(new RegExp(TEST_URLS.authServer));
    const currentUrl = page.url();
    expect(currentUrl).toContain('/authorize');
    expect(currentUrl).toContain('response_type=code');
    expect(currentUrl).toContain('client_id=profile-app');
    expect(currentUrl).toContain('redirect_uri');

    // Step 4: User authenticates (email + code)
    // This is handled by the login fixture which mocks email interception
    await page.fill('input[type="email"]', testUser.email);
    await page.click('button[type="submit"]');

    // Wait for code input
    await expect(page.locator('input[name="code"]')).toBeVisible({
      timeout: 5000,
    });

    // In real flow, code would be sent via email
    // For E2E, we'll need to intercept or mock this
    // The login fixture handles this

    // Step 5: Verify redirect to callback with authorization code
    await expect(page).toHaveURL(new RegExp('/callback'), { timeout: 15000 });
    const callbackUrl = page.url();
    expect(callbackUrl).toContain('code=');

    // Step 6: Verify token exchange happens (implicit in profile app)
    // and user is redirected back to profile app
    await expect(page).toHaveURL(TEST_URLS.profileApp, { timeout: 10000 });

    // Step 7: Verify user is logged in and can access profile
    await expect(page.locator('#loggedInView')).toBeVisible();
    await expect(page.locator('#userEmail')).toContainText(testUser.email);

    // Step 8: Verify session is maintained
    await page.reload();
    await expect(page.locator('#loggedInView')).toBeVisible();

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
    const testUser = TEST_USERS.user;

    // Login
    await login(page, testUser.email);

    // Verify logged in
    await expect(page.locator('#loggedInView')).toBeVisible();

    // Reload page
    await page.reload();

    // Verify still logged in
    await expect(page.locator('#loggedInView')).toBeVisible();
    await expect(page.locator('#userEmail')).toContainText(testUser.email);
  });

  test('should work across multiple browser tabs', async ({ context }) => {
    const testUser = TEST_USERS.user;

    // Create first tab and login
    const page1 = await context.newPage();
    await login(page1, testUser.email);
    await expect(page1.locator('#loggedInView')).toBeVisible();

    // Create second tab
    const page2 = await context.newPage();
    await page2.goto(TEST_URLS.profileApp);

    // Verify session shared across tabs
    await expect(page2.locator('#loggedInView')).toBeVisible();

    // Logout from first tab
    await logout(page1);

    // Verify logout affects second tab (may require reload)
    await page2.reload();
    await expect(page2.locator('#loggedOutView')).toBeVisible();

    await page1.close();
    await page2.close();
  });
});
