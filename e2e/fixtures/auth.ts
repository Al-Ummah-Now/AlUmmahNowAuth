/**
 * Authentication Fixtures
 *
 * Reusable authentication helpers for E2E tests.
 */

import { Page, expect } from '@playwright/test';
import { TEST_URLS } from '../utils/test-data';
import { setupEmailInterception } from '../utils/email-interceptor';

// Store registered users to avoid re-registration
const registeredUsers = new Set<string>();

// Test password for all E2E test users
// SECURITY WARNING: This password is used ONLY for local E2E tests and should NEVER be used in production.
// In production, always use strong, unique passwords for each user.
const TEST_PASSWORD = 'TestPassword123!';

/**
 * Register a new user
 *
 * @param page - Playwright page object
 * @param email - User email address
 * @returns Promise that resolves when registration is complete
 */
export async function register(page: Page, email: string): Promise<void> {
  // Skip if already registered in this test session
  if (registeredUsers.has(email)) {
    return;
  }

  // Set up email interception to capture verification code via Resend API
  const emailInterceptor = setupEmailInterception();

  // Navigate to profile app
  await page.goto(TEST_URLS.profileApp);

  // Click Sign In to go to auth page (use specific selector to avoid multiple matches)
  await page.locator('#loggedOutView button:has-text("Sign In")').click();

  // Wait for redirect to auth server
  await expect(page).toHaveURL(new RegExp(TEST_URLS.authServer));

  // Click "Register" link
  await page.click('a:has-text("Register")');

  // Fill registration form
  await page.fill('input[type="email"]', email);

  // Fill password fields (there are typically two: password and repeat password)
  const passwordFields = page.locator('input[type="password"]');
  await passwordFields.nth(0).fill(TEST_PASSWORD);
  await passwordFields.nth(1).fill(TEST_PASSWORD); // Repeat password

  // Submit registration
  await page.click('button:has-text("Continue")');

  // Wait for verification code input
  // Timeout increased to handle cold starts in QA environment
  await expect(page.locator('input[name="code"]')).toBeVisible({ timeout: 20000 });

  const verificationCode = await emailInterceptor.getLastLoginCode(email);

  if (!verificationCode) {
    throw new Error('Failed to capture verification code from email. Check that email interception is working correctly.');
  }

  // Enter verification code
  await page.fill('input[name="code"]', verificationCode);
  await page.click('button:has-text("Continue")');

  // Wait for successful registration (redirect to profile app)
  await expect(page).toHaveURL(TEST_URLS.profileApp, { timeout: 10000 });

  // Mark as registered
  registeredUsers.add(email);
}

/**
 * Perform complete login flow
 *
 * @param page - Playwright page object
 * @param email - User email address
 * @returns Promise that resolves when login is complete
 */
export async function login(page: Page, email: string): Promise<void> {
  // Register user first if not already registered
  await register(page, email);

  // Navigate to profile app
  await page.goto(TEST_URLS.profileApp);

  // Check if already logged in (registration logs user in automatically)
  const loggedInView = page.locator('#loggedInView');
  const isAlreadyLoggedIn = await loggedInView.isVisible();

  if (isAlreadyLoggedIn) {
    // User is already logged in from registration, no need to log in again
    return;
  }

  // Set up email interception for verification code via Resend API
  const emailInterceptor = setupEmailInterception();

  // Click login button (using more specific selector to avoid multiple matches)
  await page.locator('#loggedOutView button:has-text("Sign In")').click();

  // Wait for redirect to auth server
  await expect(page).toHaveURL(new RegExp(TEST_URLS.authServer));

  // Enter email address and password
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', TEST_PASSWORD);

  // Click Continue to submit login
  await page.click('button:has-text("Continue")');

  // Handle verification code if required
  // Note: Verification code is typically only required for registration.
  // For returning users (already registered), password flow may skip verification.
  const codeInput = page.locator('input[name="code"]');
  const needsVerificationCode = await codeInput.isVisible({ timeout: 3000 }).catch(() => false);

  if (needsVerificationCode) {
    // Get verification code from intercepted email
    const verificationCode = await emailInterceptor.getLastLoginCode(email);
    if (!verificationCode) {
      throw new Error('Failed to capture verification code from email during login');
    }

    // Enter verification code
    await page.fill('input[name="code"]', verificationCode);
    await page.click('button:has-text("Continue")');
  }

  // Wait for redirect back to profile app (successful login)
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
  // Wait for logout button to be visible and click it
  // Button text is "🚪 Sign Out" with emoji, but has-text matches partial text
  const logoutButton = page.locator('#loggedInView button:has-text("Sign Out")');
  await expect(logoutButton).toBeVisible({ timeout: 5000 });
  await logoutButton.click();

  // Verify redirected to logged out state
  await expect(page.locator('#loggedOutView')).toBeVisible({ timeout: 10000 });
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
