/**
 * Admin Dashboard Fixtures
 *
 * Reusable helpers for admin dashboard E2E tests.
 */

import { Page, expect } from '@playwright/test';
import { TEST_URLS, TestUser } from '../utils/test-data';

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
  // Navigate to admin dashboard
  await navigateToAdmin(page);

  // Click "Create User" button
  await page.click('button:has-text("Create User")');

  // Wait for dialog to open
  await expect(page.locator('[role="dialog"]')).toBeVisible();

  // Fill in user details
  await page.fill('input[name="email"]', user.email);
  await page.selectOption('select[name="role"]', user.role);

  // Submit form
  await page.click('button[type="submit"]:has-text("Create")');

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
  // Navigate to admin dashboard
  await navigateToAdmin(page);

  // Find user row and click edit button
  const userRow = page.locator(`tr:has-text("${email}")`);
  await userRow.locator('button:has-text("Edit")').click();

  // Wait for dialog to open
  await expect(page.locator('[role="dialog"]')).toBeVisible();

  // Update fields
  if (updates.email) {
    await page.fill('input[name="email"]', updates.email);
  }
  if (updates.role) {
    await page.selectOption('select[name="role"]', updates.role);
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
  // Navigate to admin dashboard
  await navigateToAdmin(page);

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
  // Navigate to admin dashboard
  await navigateToAdmin(page);

  // Enter search query
  await page.fill('input[placeholder*="Search"]', query);

  // Wait for results to update
  await page.waitForTimeout(500);

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
  await navigateToAdmin(page);
  const userRow = page.locator(`tr:has-text("${email}")`);
  return await userRow.isVisible();
}
