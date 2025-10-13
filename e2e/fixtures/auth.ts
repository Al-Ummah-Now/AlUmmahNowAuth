/**
 * Authentication Fixtures
 *
 * Reusable authentication helpers for E2E tests.
 */

import { Page, expect } from '@playwright/test';
import { TEST_URLS } from '../utils/test-data';
import { setupEmailInterception } from '../utils/email-interceptor';

/**
 * Perform complete login flow
 *
 * @param page - Playwright page object
 * @param email - User email address
 * @returns Promise that resolves when login is complete
 */
export async function login(page: Page, email: string): Promise<void> {
  // Set up email interception to capture login code
  const emailInterceptor = setupEmailInterception(page);

  // Navigate to profile app
  await page.goto(TEST_URLS.profileApp);

  // Click login button
  await page.click('button:has-text("Sign In")');

  // Wait for redirect to auth server
  await expect(page).toHaveURL(new RegExp(TEST_URLS.authServer));

  // Enter email address
  await page.fill('input[type="email"]', email);
  await page.click('button[type="submit"]');

  // Wait for code to be sent
  await page.waitForTimeout(1000);
  const loginCode = emailInterceptor.getLastLoginCode();

  if (!loginCode) {
    throw new Error('Failed to capture login code from email');
  }

  // Enter login code
  await page.fill('input[name="code"]', loginCode);
  await page.click('button[type="submit"]');

  // Wait for redirect back to profile app
  await expect(page).toHaveURL(TEST_URLS.profileApp, { timeout: 10000 });

  // Verify login succeeded
  await expect(page.locator('#loggedInView')).toBeVisible();
}

/**
 * Perform logout
 *
 * @param page - Playwright page object
 */
export async function logout(page: Page): Promise<void> {
  // Click logout button
  await page.click('button:has-text("Sign Out")');

  // Verify redirected to logged out state
  await expect(page.locator('#loggedOutView')).toBeVisible();
}

/**
 * Check if user is logged in
 *
 * @param page - Playwright page object
 * @returns True if user is logged in
 */
export async function isLoggedIn(page: Page): Promise<boolean> {
  await page.goto(TEST_URLS.profileApp);
  const loggedInView = page.locator('#loggedInView');
  return await loggedInView.isVisible();
}

/**
 * Get current user info from profile page
 *
 * @param page - Playwright page object
 * @returns User information
 */
export async function getCurrentUser(page: Page): Promise<{
  id: string;
  email: string;
  role: string;
}> {
  await page.goto(TEST_URLS.profileApp);
  await expect(page.locator('#loggedInView')).toBeVisible();

  const userId = await page.locator('#userId').textContent();
  const userEmail = await page.locator('#userEmail').textContent();
  const userRole = await page.locator('#userRole').textContent();

  if (!userId || !userEmail || !userRole) {
    throw new Error('Failed to get user information');
  }

  return {
    id: userId,
    email: userEmail,
    role: userRole.toLowerCase(),
  };
}
