/**
 * E2E Test: Logout Flow
 *
 * Tests the logout functionality across the application.
 */

import { test, expect } from '@playwright/test';
import { login, logout, isLoggedIn, expectSignInPage } from '../../fixtures/auth';
import { TEST_USERS, TEST_URLS } from '../../utils/test-data';

test.describe('Logout Flow', () => {
  test('should successfully logout from profile app', async ({ page }) => {
    const testUser = TEST_USERS.user();

    // Login first
    await login(page, testUser.email);

    // Verify logged in
    let loggedIn = await isLoggedIn(page);
    expect(loggedIn).toBe(true);

    // Perform logout
    await logout(page);

    // Verify logged out
    loggedIn = await isLoggedIn(page);
    expect(loggedIn).toBe(false);

    // Signed out: the profile app goes straight to the sign-in form
    await expectSignInPage(page);
  });

  test('should clear session cookie on logout', async ({ page }) => {
    const testUser = TEST_USERS.user();

    // Login
    await login(page, testUser.email);

    // Get cookies before logout
    const cookiesBefore = await page.context().cookies();
    const sessionCookieBefore = cookiesBefore.find(
      (c) => c.name === 'profile_session'
    );
    expect(sessionCookieBefore).toBeDefined();

    // Logout
    await logout(page);

    // Verify session cookie is cleared or expired
    const cookiesAfter = await page.context().cookies();
    const sessionCookieAfter = cookiesAfter.find(
      (c) => c.name === 'profile_session'
    );

    // Cookie should be deleted or have Max-Age=0
    if (sessionCookieAfter) {
      expect(sessionCookieAfter.expires).toBeLessThanOrEqual(Date.now() / 1000);
    }
  });

  test('should redirect to homepage after logout', async ({ page }) => {
    const testUser = TEST_USERS.user();

    // Login
    await login(page, testUser.email);

    // Logout (use specific selector to target the button in logged-in view)
    // Use .first() to avoid strict mode violation if account switcher has "Sign out of all accounts"
    const logoutButton = page.locator('#loggedInView button:has-text("Sign Out")').first();
    await expect(logoutButton).toBeVisible({ timeout: 10000 });
    await logoutButton.click();

    // Back through the profile app, which (signed out) now sends the
    // browser to the sign-in form instead of a landing page
    await expectSignInPage(page);
  });

  test('should require re-authentication after logout', async ({ page }) => {
    const testUser = TEST_USERS.user();

    // Login
    await login(page, testUser.email);

    // Logout
    await logout(page);

    // Try to access profile without logging in
    await page.goto(TEST_URLS.profileApp);

    // Verify user is not authenticated (no silent sign-in after logout)
    await expectSignInPage(page);
    await expect(page.locator('#loggedInView')).toHaveCount(0);
  });
});
