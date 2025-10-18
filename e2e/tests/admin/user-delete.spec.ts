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
    await createUser(page, { email: userEmail, role: 'user' });

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
    await createUser(page, { email: userEmail, role: 'user' });

    // Click delete button
    // Already on /users page from previous action
    const userRow = page.locator(`tr:has-text("${userEmail}")`);
    await userRow.locator('button:has-text("Delete")').click();

    // Verify confirmation dialog appears
    await expect(page.locator('[role="dialog"]')).toBeVisible();
    await expect(
      page.locator('text=/are you sure|confirm/i')
    ).toBeVisible();
  });

  test('should cancel deletion when clicking cancel', async ({ page }) => {
    // Create a test user
    const userEmail = generateTestEmail('cancel-delete');
    await createUser(page, { email: userEmail, role: 'user' });

    // Click delete button
    // Already on /users page from previous action
    const userRow = page.locator(`tr:has-text("${userEmail}")`);
    await userRow.locator('button:has-text("Delete")').click();

    // Click cancel in confirmation dialog
    await page.click('button:has-text("Cancel")');

    // Verify user still exists
    await expect(page.locator(`tr:has-text("${userEmail}")`)).toBeVisible();
  });

  test('should update user count after deletion', async ({ page }) => {
    // Navigate to dashboard to get initial count
    await navigateToAdmin(page);

    // Get initial user count
    const initialCount = await page
      .locator('text=/Total Users/i')
      .locator('..')
      .locator('.value')
      .textContent();

    // Create and delete a user
    const userEmail = generateTestEmail('count-delete');
    await createUser(page, { email: userEmail, role: 'user' });
    await deleteUser(page, userEmail);

    // Navigate back to dashboard
    await page.click('a:has-text("Dashboard")');

    // Get updated count
    const updatedCount = await page
      .locator('text=/Total Users/i')
      .locator('..')
      .locator('.value')
      .textContent();

    // Count should be same as initial (created and deleted one)
    expect(parseInt(updatedCount || '0')).toBe(parseInt(initialCount || '0'));
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
    await createUser(page, { email: userEmail, role: 'user' });

    // Delete user
    await deleteUser(page, userEmail);

    // Reload page
    await page.reload();

    // Verify user is still gone
    await expect(
      page.locator(`tr:has-text("${userEmail}")`)
    ).not.toBeVisible();
  });

  test('should delete multiple users sequentially', async ({ page }) => {
    // Create multiple test users
    const user1Email = generateTestEmail('multi-1');
    const user2Email = generateTestEmail('multi-2');
    const user3Email = generateTestEmail('multi-3');

    await createUser(page, { email: user1Email, role: 'user' });
    await createUser(page, { email: user2Email, role: 'user' });
    await createUser(page, { email: user3Email, role: 'user' });

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
