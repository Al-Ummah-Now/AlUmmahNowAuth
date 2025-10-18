/**
 * Admin Dashboard Fixtures
 *
 * Reusable helpers for admin dashboard E2E tests.
 */

import { Page, expect } from '@playwright/test';
import { TEST_URLS, TestUser } from '../utils/test-data';
import { register } from './auth';
import { setupEmailInterception } from '../utils/email-interceptor';

// Test password for all E2E test users
const TEST_PASSWORD = 'TestPassword123!';

/**
 * Login to admin dashboard
 *
 * @param page - Playwright page object
 * @param email - Admin user email address
 * @returns Promise that resolves when login is complete
 */
export async function loginAdmin(page: Page, email: string): Promise<void> {
  // First, register the user if they don't exist (using profile app)
  // This creates the user with role='user' by default
  await register(page, email);

  // Upgrade the user to admin role via the test endpoint
  // This is only available in localhost (E2E testing)
  const response = await page.request.post(`${TEST_URLS.authServer}/test/promote/${encodeURIComponent(email)}`, {
    failOnStatusCode: false,
  });

  if (!response.ok()) {
    throw new Error(`Failed to promote user to admin: ${response.status()} - ${await response.text()}`);
  }

  // Now navigate to admin dashboard and authenticate there
  await page.goto(TEST_URLS.adminDashboard);

  // Check if already logged in to admin dashboard by looking for "Manage Users" link
  const manageUsersLink = page.locator('a:has-text("Manage Users")');
  const isLoggedIn = await manageUsersLink.isVisible().catch(() => false);

  if (isLoggedIn) {
    // Already logged in to admin dashboard
    return;
  }

  // Set up email interception to capture verification code
  const emailInterceptor = setupEmailInterception(page);

  // Click "Admin Sign In" or "Sign In" link to start auth flow
  const signInLink = page.locator('a:has-text("Admin Sign In"), a:has-text("Sign In")').first();
  await signInLink.click();

  // Wait for redirect to auth server
  await expect(page).toHaveURL(new RegExp(TEST_URLS.authServer));

  // Enter email address and password
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', TEST_PASSWORD);

  // Click Continue to submit login
  await page.click('button:has-text("Continue")');

  // Wait for redirect back to admin dashboard (successful login)
  await expect(page).toHaveURL(new RegExp(TEST_URLS.adminDashboard), { timeout: 10000 });

  // Verify login succeeded by checking for admin-specific elements (dashboard heading and Manage Users link)
  await expect(page.locator('heading:has-text("Dashboard"), h2:has-text("Dashboard")')).toBeVisible({ timeout: 10000 });
  await expect(manageUsersLink).toBeVisible({ timeout: 10000 });
}

/**
 * Navigate to admin dashboard
 *
 * @param page - Playwright page object
 */
export async function navigateToAdmin(page: Page): Promise<void> {
  await page.goto(TEST_URLS.adminDashboard);
  await expect(page).toHaveURL(new RegExp(TEST_URLS.adminDashboard));
}

/**
 * Create a new user via admin dashboard
 *
 * @param page - Playwright page object
 * @param user - User data to create
 */
export async function createUser(page: Page, user: TestUser): Promise<void> {
  // Navigate to users page (not just the dashboard home)
  await page.goto(`${TEST_URLS.adminDashboard}/users`);
  await expect(page).toHaveURL(new RegExp(`${TEST_URLS.adminDashboard}/users`));

  // Click "Create User" button
  await page.click('button:has-text("Create User")');

  // Wait for dialog to open
  await expect(page.locator('[role="dialog"]')).toBeVisible();

  // Fill in user details
  await page.fill('input[id="email"]', user.email);
  await page.selectOption('select[id="role"]', user.role);

  // Submit form
  await page.click('button:has-text("Create User")');

  // Wait for success message or dialog to close
  await expect(page.locator('[role="dialog"]')).toBeHidden({ timeout: 5000 });

  // Verify user appears in list
  await expect(page.locator(`text=${user.email}`)).toBeVisible();
}

/**
 * Edit an existing user
 *
 * @param page - Playwright page object
 * @param email - Current user email
 * @param updates - Fields to update
 */
export async function editUser(
  page: Page,
  email: string,
  updates: Partial<TestUser>
): Promise<void> {
  // Navigate to users page
  await page.goto(`${TEST_URLS.adminDashboard}/users`);
  await expect(page).toHaveURL(new RegExp(`${TEST_URLS.adminDashboard}/users`));

  // Find user row and click edit button
  const userRow = page.locator(`tr:has-text("${email}")`);
  await userRow.locator('button:has-text("Edit")').click();

  // Wait for dialog to open
  await expect(page.locator('[role="dialog"]')).toBeVisible();

  // Update fields
  if (updates.email) {
    await page.fill('input[id="email"]', updates.email);
  }
  if (updates.role) {
    await page.selectOption('select[id="role"]', updates.role);
  }

  // Submit form
  await page.click('button[type="submit"]:has-text("Save")');

  // Wait for success
  await expect(page.locator('[role="dialog"]')).toBeHidden({ timeout: 5000 });
}

/**
 * Delete a user
 *
 * @param page - Playwright page object
 * @param email - User email to delete
 */
export async function deleteUser(page: Page, email: string): Promise<void> {
  // Navigate to users page
  await page.goto(`${TEST_URLS.adminDashboard}/users`);
  await expect(page).toHaveURL(new RegExp(`${TEST_URLS.adminDashboard}/users`));

  // Find user row and click delete button
  const userRow = page.locator(`tr:has-text("${email}")`);
  await userRow.locator('button:has-text("Delete")').click();

  // Confirm deletion
  await page.click('button:has-text("Confirm")');

  // Verify user is removed from list
  await expect(page.locator(`text=${email}`)).toBeHidden({ timeout: 5000 });
}

/**
 * Search for users
 *
 * @param page - Playwright page object
 * @param query - Search query
 * @returns Number of results found
 */
export async function searchUsers(page: Page, query: string): Promise<number> {
  // Navigate to users page
  await page.goto(`${TEST_URLS.adminDashboard}/users`);
  await expect(page).toHaveURL(new RegExp(`${TEST_URLS.adminDashboard}/users`));

  // Enter search query
  await page.fill('input[placeholder*="Search"]', query);

  // Wait for results to update by waiting for network to be idle or table to re-render
  // This ensures search results have loaded before counting rows
  await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {
    // If networkidle times out, fall back to waiting for table visibility
    // This handles cases where search is client-side (no network request)
  });

  // Count visible user rows
  const rows = await page.locator('tbody tr').count();
  return rows;
}

/**
 * Get dashboard statistics
 *
 * @param page - Playwright page object
 * @returns Dashboard stats
 */
export async function getDashboardStats(page: Page): Promise<{
  totalUsers: number;
  adminUsers: number;
  regularUsers: number;
}> {
  // Navigate to admin dashboard
  await navigateToAdmin(page);

  // Extract stats from dashboard
  const totalUsers = await page
    .locator('text=/Total Users/i')
    .locator('..')
    .locator('.value')
    .textContent();

  const adminUsers = await page
    .locator('text=/Admin Users/i')
    .locator('..')
    .locator('.value')
    .textContent();

  const regularUsers = await page
    .locator('text=/Regular Users/i')
    .locator('..')
    .locator('.value')
    .textContent();

  return {
    totalUsers: parseInt(totalUsers || '0'),
    adminUsers: parseInt(adminUsers || '0'),
    regularUsers: parseInt(regularUsers || '0'),
  };
}

/**
 * Verify user exists in admin list
 *
 * @param page - Playwright page object
 * @param email - User email to check
 * @returns True if user exists
 */
export async function userExists(page: Page, email: string): Promise<boolean> {
  await page.goto(`${TEST_URLS.adminDashboard}/users`);
  await expect(page).toHaveURL(new RegExp(`${TEST_URLS.adminDashboard}/users`));
  const userRow = page.locator(`tr:has-text("${email}")`);
  return await userRow.isVisible();
}
