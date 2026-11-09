/**
 * E2E Test: Email-Based Login Flow
 *
 * Tests the complete authentication flow from profile app through auth server
 * and back to profile app.
 */

import { test, expect } from '@playwright/test';
import { login, isLoggedIn, getCurrentUser, expectSignInPage } from '../../fixtures/auth';
import { TEST_USERS, TEST_URLS } from '../../utils/test-data';

// Signs in with the test password / one-time codes (or sends test secrets in headers):
// traces would record them, so none for this file. See e2e/utils/secret-input.ts.
test.use({ trace: 'off' });

test.describe('Email-Based Login Flow', () => {
  test('should complete full login flow successfully', async ({ page }) => {
    const testUser = TEST_USERS.user();

    // Navigate to profile app
    await page.goto(TEST_URLS.profileApp);

    // Not signed in: straight to the sign-in form (no landing page)
    await expectSignInPage(page);

    // Perform login
    await login(page, testUser.email);

    // Verify logged in state
    const loggedIn = await isLoggedIn(page);
    expect(loggedIn).toBe(true);

    // Verify user information is displayed
    const currentUser = await getCurrentUser(page);
    expect(currentUser.email).toBe(testUser.email);
    expect(currentUser.role.toLowerCase()).toBe(testUser.role);
  });

  test('shows no landing page when not authenticated', async ({ page }) => {
    await page.goto(TEST_URLS.profileApp);

    // No "Welcome to Your Profile ... Sign In" interstitial: the sign-in form
    await expectSignInPage(page);
    await expect(page.locator('#loggedOutView')).toHaveCount(0);
  });

  test('should redirect to auth server without a click', async ({ page }) => {
    await page.goto(TEST_URLS.profileApp);

    // Wait for redirect to auth server
    await expect(page).toHaveURL(new RegExp(TEST_URLS.authServer), {
      timeout: 10000,
    });

    // Verify auth page elements
    await expect(page.locator('input[type="email"]')).toBeVisible();
  });

  test('should handle invalid email format', async ({ page }) => {
    await page.goto(TEST_URLS.profileApp);

    // Wait for auth server page
    await expect(page).toHaveURL(new RegExp(TEST_URLS.authServer));

    // Enter invalid email
    await page.fill('input[type="email"]', 'not-an-email');
    await page.click('button:has-text("Continue")');

    // Verify error or validation message
    // OpenAuth should show validation error for invalid email format
    // Check for either HTML5 validation or custom error message
    const hasValidationError = await page.locator('input[type="email"]:invalid').isVisible()
      .catch(() => false);
    const hasErrorMessage = await page.locator('text=/invalid|email/i').isVisible()
      .catch(() => false);

    expect(hasValidationError || hasErrorMessage).toBe(true);
  });
});
