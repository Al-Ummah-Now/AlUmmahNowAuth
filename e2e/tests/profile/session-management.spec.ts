/**
 * E2E Test: Session Management
 *
 * Tests session persistence, expiration, and management.
 */

import { test, expect } from '@playwright/test';
import { login, logout } from '../../fixtures/auth';
import { TEST_USERS, TEST_URLS } from '../../utils/test-data';

test.describe('Session Management', () => {
  test('should persist session across page reloads', async ({ page }) => {
    const testUser = TEST_USERS.user();

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

  test('should persist session across browser restarts', async ({
    browser,
  }) => {
    const testUser = TEST_USERS.user();

    // Create context with persistent storage
    const context = await browser.newContext({
      storageState: undefined,
    });
    const page = await context.newPage();

    // Login
    await login(page, testUser.email);

    // Save storage state
    const storageState = await context.storageState();

    // Close context
    await context.close();

    // Create new context with saved storage
    const newContext = await browser.newContext({ storageState });
    const newPage = await newContext.newPage();

    // Navigate to profile app
    await newPage.goto(TEST_URLS.profileApp);

    // Verify still logged in
    await expect(newPage.locator('#loggedInView')).toBeVisible();

    await newContext.close();
  });

  test('should maintain session when navigating between apps', async ({
    page,
  }) => {
    const testUser = TEST_USERS.user();

    // Login on profile app
    await login(page, testUser.email);

    // Navigate to admin dashboard
    await page.goto(TEST_URLS.adminDashboard);

    // Verify session maintained (may require shared session logic)
    // Note: This depends on how sessions are shared between apps
    await page.waitForLoadState('networkidle');

    // Navigate back to profile app
    await page.goto(TEST_URLS.profileApp);

    // Verify still logged in
    await expect(page.locator('#loggedInView')).toBeVisible();
  });

  test('should have correct session cookie attributes', async ({ page }) => {
    const testUser = TEST_USERS.user();

    // Login
    await login(page, testUser.email);

    // Get session cookie
    const cookies = await page.context().cookies();
    const sessionCookie = cookies.find((c) => c.name === 'profile_session');

    // Verify cookie attributes
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie?.httpOnly).toBe(true); // HttpOnly flag
    expect(sessionCookie?.sameSite).toBe('Lax'); // SameSite attribute
    expect(sessionCookie?.path).toBe('/'); // Path

    // In production, should have Secure flag
    // expect(sessionCookie?.secure).toBe(true);
  });

  test('should clear session on explicit logout', async ({ page }) => {
    const testUser = TEST_USERS.user();

    // Login
    await login(page, testUser.email);

    // Logout
    await logout(page);

    // Try to access profile
    await page.goto(TEST_URLS.profileApp);

    // Verify session cleared
    await expect(page.locator('#loggedOutView')).toBeVisible();
  });

  test('should not share session with incognito/different context', async ({
    browser,
  }) => {
    const testUser = TEST_USERS.user();

    // Login in first context
    const context1 = await browser.newContext();
    const page1 = await context1.newPage();
    await login(page1, testUser.email);
    await expect(page1.locator('#loggedInView')).toBeVisible();

    // Create second context (incognito-like)
    const context2 = await browser.newContext();
    const page2 = await context2.newPage();
    await page2.goto(TEST_URLS.profileApp);

    // Verify not logged in second context
    await expect(page2.locator('#loggedOutView')).toBeVisible();

    await context1.close();
    await context2.close();
  });

  test('should handle corrupted session cookie gracefully', async ({
    page,
    context,
  }) => {
    // Set corrupted session cookie
    await context.addCookies([
      {
        name: 'profile_session',
        value: 'corrupted-invalid-token',
        domain: 'localhost',
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);

    // Navigate to profile app
    await page.goto(TEST_URLS.profileApp);

    // Verify treated as logged out
    await expect(page.locator('#loggedOutView')).toBeVisible();
  });

  test('should handle missing session gracefully', async ({ page }) => {
    // Navigate without logging in
    await page.goto(TEST_URLS.profileApp);

    // Verify shows logged out state
    await expect(page.locator('#loggedOutView')).toBeVisible();
    await expect(page.locator('button:has-text("Sign In")')).toBeVisible();
  });

  test('should create new session after logout and login', async ({
    page,
    context,
  }) => {
    const testUser = TEST_USERS.user();

    // Login
    await login(page, testUser.email);

    // Get first session cookie
    const cookies1 = await context.cookies();
    const session1 = cookies1.find((c) => c.name === 'profile_session');
    const sessionValue1 = session1?.value;

    // Logout
    await logout(page);

    // Login again
    await login(page, testUser.email);

    // Get second session cookie
    const cookies2 = await context.cookies();
    const session2 = cookies2.find((c) => c.name === 'profile_session');
    const sessionValue2 = session2?.value;

    // Verify different session tokens (new session created)
    expect(sessionValue1).not.toBe(sessionValue2);
  });
});
