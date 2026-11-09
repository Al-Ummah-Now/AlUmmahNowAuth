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

  // Navigate to profile app: without a session it goes straight to sign-in
  await page.goto(TEST_URLS.profileApp);

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

  // Enter verification code with retry logic
  // Sometimes form submission fails under load - retry up to 3 times
  let codeSubmissionSuccess = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    // Clear any previous value and enter code
    await page.fill('input[name="code"]', '');
    await page.fill('input[name="code"]', verificationCode);

    // Small delay to ensure the form recognizes the input
    await page.waitForTimeout(100);

    // Wait for button to be enabled and click
    const continueBtn = page.locator('button:has-text("Continue")');
    await expect(continueBtn).toBeEnabled({ timeout: 5000 });
    await continueBtn.click();

    // Wait for redirect to profile app (or check if still on code page)
    try {
      await expect(page).toHaveURL(TEST_URLS.profileApp, { timeout: 10000 });
      codeSubmissionSuccess = true;
      break;
    } catch {
      // Check if we're still on the code page (submission may have failed)
      const stillOnCodePage = await page.locator('input[name="code"]').isVisible().catch(() => false);
      if (stillOnCodePage && attempt < 3) {
        console.log(`Verification code submission attempt ${attempt} failed, retrying...`);
        continue;
      }
      // Final attempt or not on code page - let it fail
      if (attempt === 3) {
        throw new Error(`Verification code submission failed after ${attempt} attempts. Page URL: ${page.url()}`);
      }
    }
  }

  if (!codeSubmissionSuccess) {
    throw new Error('Verification code submission did not complete successfully');
  }

  // Wait for session to be established (logged in view visible)
  // This ensures the session cookie is set before proceeding
  // Wait for network to be idle - this ensures OAuth callback token exchange completes
  // and the page JavaScript has fully initialized
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForLoadState('domcontentloaded');
  // The profile app toggles visibility via JS - give it time to execute
  await expect(page.locator('#loggedInView')).toBeVisible({ timeout: 20000 });

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
  // register() now ensures #loggedInView is visible before returning
  await register(page, email);

  // Verify we're still on profile app and logged in
  // (register() leaves us on profile app with session established)
  const currentUrl = page.url();
  if (currentUrl.includes(TEST_URLS.profileApp)) {
    const loggedInView = page.locator('#loggedInView');
    const isAlreadyLoggedIn = await loggedInView.isVisible();
    if (isAlreadyLoggedIn) {
      // User is already logged in from registration
      return;
    }
  }

  // If not on profile app or not logged in, navigate and check again
  await page.goto(TEST_URLS.profileApp);

  // Check if already logged in
  const loggedInView = page.locator('#loggedInView');
  const isAlreadyLoggedIn = await loggedInView.isVisible();

  if (isAlreadyLoggedIn) {
    // User is logged in
    return;
  }

  // Set up email interception for verification code via Resend API
  const emailInterceptor = setupEmailInterception();

  // No landing page: the profile app already redirected into sign-in
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

    // Enter verification code with retry logic
    for (let attempt = 1; attempt <= 3; attempt++) {
      await page.fill('input[name="code"]', '');
      await page.fill('input[name="code"]', verificationCode);
      await page.waitForTimeout(100);

      const continueBtn = page.locator('button:has-text("Continue")');
      await expect(continueBtn).toBeEnabled({ timeout: 5000 });
      await continueBtn.click();

      try {
        await expect(page).toHaveURL(TEST_URLS.profileApp, { timeout: 10000 });
        break;
      } catch {
        const stillOnCodePage = await page.locator('input[name="code"]').isVisible().catch(() => false);
        if (stillOnCodePage && attempt < 3) {
          console.log(`Login verification code attempt ${attempt} failed, retrying...`);
          continue;
        }
        if (attempt === 3) {
          throw new Error(`Login verification code submission failed after ${attempt} attempts. Page URL: ${page.url()}`);
        }
      }
    }
  } else {
    // No verification code needed - wait for redirect
    await expect(page).toHaveURL(TEST_URLS.profileApp, { timeout: 10000 });
  }

  // Verify login succeeded
  // Wait for network to be idle - this ensures OAuth callback token exchange completes
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForLoadState('domcontentloaded');
  // The profile app toggles visibility via JS - give it time to execute
  await expect(page.locator('#loggedInView')).toBeVisible({ timeout: 20000 });
}

/**
 * Perform logout
 *
 * @param page - Playwright page object
 */
export async function logout(page: Page): Promise<void> {
  // Wait for logout button to be visible and click it
  // Button text is "🚪 Sign Out" with emoji, but has-text matches partial text
  // Use .first() to avoid strict mode violation if account switcher has "Sign out of all accounts"
  const logoutButton = page.locator('#loggedInView button:has-text("Sign Out")').first();
  await expect(logoutButton).toBeVisible({ timeout: 5000 });
  await logoutButton.click();

  // Signed out everywhere: the profile app now goes straight to the sign-in form
  await expectSignInPage(page);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The auth server's sign-in form (where an app without a session lands now
 * that the apps have no "Sign In" landing pages of their own).
 */
export async function expectSignInPage(page: Page, timeout = 15000): Promise<void> {
  await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(TEST_URLS.authServer)}/`), { timeout });
  await expect(page.locator('input[type="email"]')).toBeVisible({ timeout });
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
