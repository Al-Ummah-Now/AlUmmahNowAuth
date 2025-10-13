/**
 * E2E Test: Email-Based Login Flow
 *
 * Tests the complete authentication flow from profile app through auth server
 * and back to profile app.
 */

import { test, expect } from '@playwright/test';
import { login, isLoggedIn, getCurrentUser } from '../../fixtures/auth';
import { TEST_USERS, TEST_URLS } from '../../utils/test-data';

test.describe('Email-Based Login Flow', () => {
  test('should complete full login flow successfully', async ({ page }) => {
    const testUser = TEST_USERS.user;

    // Navigate to profile app
    await page.goto(TEST_URLS.profileApp);

    // Verify logged out state
    await expect(page.locator('#loggedOutView')).toBeVisible();
    await expect(page.locator('button:has-text("Sign In")')).toBeVisible();

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

  test('should show login button when not authenticated', async ({ page }) => {
    await page.goto(TEST_URLS.profileApp);

    // Verify logged out view is visible
    await expect(page.locator('#loggedOutView')).toBeVisible();
    await expect(page.locator('button:has-text("Sign In")')).toBeVisible();

    // Verify logged in view is not visible
    await expect(page.locator('#loggedInView')).not.toBeVisible();
  });

  test('should redirect to auth server when clicking login', async ({ page }) => {
    await page.goto(TEST_URLS.profileApp);

    // Click login button
    await page.click('button:has-text("Sign In")');

    // Wait for redirect to auth server
    await expect(page).toHaveURL(new RegExp(TEST_URLS.authServer), {
      timeout: 10000,
    });

    // Verify auth page elements
    await expect(page.locator('input[type="email"]')).toBeVisible();
  });

  test('should handle invalid email format', async ({ page }) => {
    await page.goto(TEST_URLS.profileApp);
    await page.click('button:has-text("Sign In")');

    // Wait for auth server page
    await expect(page).toHaveURL(new RegExp(TEST_URLS.authServer));

    // Enter invalid email
    await page.fill('input[type="email"]', 'not-an-email');
    await page.click('button[type="submit"]');

    // Verify error or validation message
    // Note: Exact error handling depends on OpenAuth implementation
    await expect(
      page.locator('input[type="email"]:invalid')
    ).toBeVisible();
  });
});
