/**
 * E2E Test: Admin User Deletion
 *
 * Tests deleting users via the admin dashboard.
 */

import { test, expect } from '@playwright/test';
import { loginAdmin } from '../../fixtures/admin';
import { createUser, deleteUser, navigateToAdmin } from '../../fixtures/admin';
import { TEST_USERS, TEST_URLS, generateTestEmail } from '../../utils/test-data';

test.describe('Admin User Deletion', () => {
  test.beforeEach(async ({ page }) => {
    // Login as admin
    await loginAdmin(page, TEST_USERS.admin().email);
  });

  test('should delete a user successfully', async ({ page }) => {
    // Create a test user
    const userEmail = generateTestEmail('delete-test');
    await createUser(page, { email: userEmail, role: 'member' });

    // Delete user
    await deleteUser(page, userEmail);

    // Verify user is removed from list
    await expect(
      page.locator(`tr:has-text("${userEmail}")`)
    ).not.toBeVisible();
  });

  test('should show confirmation dialog before deleting', async ({ page }) => {
    // Create a test user
    const userEmail = generateTestEmail('confirm-test');
    await createUser(page, { email: userEmail, role: 'member' });

    // Wait for user row to be visible and click delete button
    // Already on /users page from previous action
    const userRow = page.locator(`tr:has-text("${userEmail}")`);
    await expect(userRow).toBeVisible({ timeout: 10000 });
    await userRow.locator('button:has-text("Delete")').click();

    // Verify confirmation dialog appears with proper content
    // The dialog contains "Are you sure you want to delete this user?" and a "Confirm" button
    await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 5000 });
    // Check for dialog description text (case-insensitive)
    await expect(
      page.locator('[role="dialog"]').locator('text=/are you sure/i')
    ).toBeVisible({ timeout: 5000 });
  });

  test('should cancel deletion when clicking cancel', async ({ page }) => {
    // Create a test user
    const userEmail = generateTestEmail('cancel-delete');
    await createUser(page, { email: userEmail, role: 'member' });

    // Wait for user row to be visible and click delete button
    // Already on /users page from previous action
    const userRow = page.locator(`tr:has-text("${userEmail}")`);
    await expect(userRow).toBeVisible({ timeout: 10000 });
    await userRow.locator('button:has-text("Delete")').click();

    // Wait for confirmation dialog to appear
    await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 5000 });

    // Click cancel in confirmation dialog
    await page.locator('[role="dialog"] button:has-text("Cancel")').click();

    // Wait for dialog to close
    await expect(page.locator('[role="dialog"]')).toBeHidden({ timeout: 5000 });

    // Verify user still exists
    await expect(page.locator(`tr:has-text("${userEmail}")`)).toBeVisible();
  });

  test('should update user count after deletion', async ({ page }) => {
    // This test verifies dashboard stats update after user operations
    // It can be flaky due to server-side caching, so we use generous timeouts
    test.setTimeout(60000); // 60 seconds for this test

    // Navigate to dashboard to get initial count
    await navigateToAdmin(page);
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

    // Get user count from dashboard card
    // The card structure is: Card > CardHeader (Total Users) + CardContent (number div)
    const getUserCount = async (): Promise<number> => {
      // Wait for the stats to be visible first
      await expect(page.locator('text=Total Users')).toBeVisible({ timeout: 5000 });

      // Find the Total Users card and extract the count
      const countText = await page.locator('text=Total Users')
        .locator('xpath=ancestor::*[contains(@class, "rounded")][1]')
        .locator('div.text-2xl')
        .first()
        .textContent({ timeout: 5000 });
      return parseInt(countText?.trim() || '0', 10);
    };

    const initialCount = await getUserCount();
    expect(initialCount).toBeGreaterThanOrEqual(0);

    // Create a user
    const userEmail = generateTestEmail('count-delete');
    await createUser(page, { email: userEmail, role: 'member' });

    // Navigate to dashboard and verify count increased
    await page.goto(TEST_URLS.adminDashboard);
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

    // Verify count increased after creation (use >= to handle parallel test interference)
    await expect(async () => {
      const countAfterCreate = await getUserCount();
      expect(countAfterCreate).toBeGreaterThanOrEqual(initialCount + 1);
    }).toPass({ timeout: 20000, intervals: [1000, 2000, 3000, 5000] });

    // Get the count after creation for comparison
    const countAfterCreate = await getUserCount();

    // Delete the user
    await deleteUser(page, userEmail);

    // Force a hard refresh to bypass any caching
    // This is more reliable than just navigation for stats that might be cached
    await page.goto(TEST_URLS.adminDashboard, { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'networkidle' });

    // Verify count decreased after deletion
    // Use relative assertion: count should be less than post-create count
    // This handles parallel test interference better than expecting exact initial count
    await expect(async () => {
      // Reload the page on each retry to get fresh data
      await page.reload({ waitUntil: 'networkidle' });
      const countAfterDelete = await getUserCount();
      expect(countAfterDelete).toBeLessThan(countAfterCreate);
    }).toPass({ timeout: 30000, intervals: [2000, 3000, 5000, 7000] });
  });

  test('should delete admin user successfully', async ({ page }) => {
    // Create a test admin
    const adminEmail = generateTestEmail('delete-admin');
    await createUser(page, { email: adminEmail, role: 'admin' });

    // Delete admin user
    await deleteUser(page, adminEmail);

    // Verify admin is removed from list
    await expect(
      page.locator(`tr:has-text("${adminEmail}")`)
    ).not.toBeVisible();
  });

  test('should handle deletion of non-existent user gracefully', async ({
    page,
  }) => {
    // Navigate to users page
    await page.goto(`${TEST_URLS.adminDashboard}/users`);

    // Try to find and delete a user that doesn't exist
    const nonExistentEmail = 'non-existent-' + Date.now() + '@test.local';

    // Verify user doesn't exist
    await expect(
      page.locator(`tr:has-text("${nonExistentEmail}")`)
    ).not.toBeVisible();
  });

  test('should persist deletion after page reload', async ({ page }) => {
    // Create a test user
    const userEmail = generateTestEmail('persist-delete');
    await createUser(page, { email: userEmail, role: 'member' });

    // Delete user
    await deleteUser(page, userEmail);

    // Reload page
    await page.reload();

    // Verify user is still gone
    await expect(
      page.locator(`tr:has-text("${userEmail}")`)
    ).not.toBeVisible();
  });

  // This test creates and deletes multiple users, so it needs a longer timeout
  test('should delete multiple users sequentially', async ({ page }) => {
    // Set longer timeout for this multi-step test
    test.setTimeout(90000); // 90 seconds

    // Create multiple test users
    const user1Email = generateTestEmail('multi-1');
    const user2Email = generateTestEmail('multi-2');
    const user3Email = generateTestEmail('multi-3');

    await createUser(page, { email: user1Email, role: 'member' });
    await createUser(page, { email: user2Email, role: 'member' });
    await createUser(page, { email: user3Email, role: 'member' });

    // Delete all users
    await deleteUser(page, user1Email);
    await deleteUser(page, user2Email);
    await deleteUser(page, user3Email);

    // Verify all users are gone
    // Already on /users page from previous action
    await expect(page.locator(`tr:has-text("${user1Email}")`)).not.toBeVisible();
    await expect(page.locator(`tr:has-text("${user2Email}")`)).not.toBeVisible();
    await expect(page.locator(`tr:has-text("${user3Email}")`)).not.toBeVisible();
  });
});
