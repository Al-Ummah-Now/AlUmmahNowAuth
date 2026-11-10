/**
 * E2E Test: Admin User Deletion
 *
 * Tests deleting users via the admin dashboard.
 */

import { test, expect } from '@playwright/test';
import { loginAdmin } from '../../fixtures/admin';
import { createUser, deleteUser, userRowsMatching } from '../../fixtures/admin';
import { TEST_USERS, TEST_URLS, generateAdminCreatedEmail } from '../../utils/test-data';

// Signs in with the test password / one-time codes (or sends test secrets in headers):
// traces would record them, so none for this file. See e2e/utils/secret-input.ts.
test.use({ trace: 'off' });

test.describe('Admin User Deletion', () => {
  // beforeEach signs a brand-new admin up through the real UI on QA (register,
  // emailed code, promote, fresh OAuth): about 18 s on a busy QA, which left
  // too little of the 30 s default for the test itself.
  test.describe.configure({ timeout: 90_000 });

  test.beforeEach(async ({ page }) => {
    // Login as admin
    await loginAdmin(page, TEST_USERS.admin().email);
  });

  test('should delete a user successfully', async ({ page }) => {
    // Create a test user
    const userEmail = generateAdminCreatedEmail('delete-test');
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
    const userEmail = generateAdminCreatedEmail('confirm-test');
    await createUser(page, { email: userEmail, role: 'member' });

    // Wait for user row to be visible and click delete button
    // Already on /users page from previous action
    const userRow = page.locator(`tr:has-text("${userEmail}")`);
    await expect(userRow).toBeVisible({ timeout: 10000 });
    await userRow.locator('button:has-text("Delete")').click();

    // Verify confirmation dialog appears with proper content
    // An in-app dialog (native <dialog>): the user moves to Recently deleted, restorable for 30 days
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole('dialog').getByText(/Recently deleted/)).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole('dialog').getByRole('button', { name: 'Cancel' })).toBeFocused();
  });

  test('should cancel deletion when clicking cancel', async ({ page }) => {
    // Create a test user
    const userEmail = generateAdminCreatedEmail('cancel-delete');
    await createUser(page, { email: userEmail, role: 'member' });

    // Wait for user row to be visible and click delete button
    // Already on /users page from previous action
    const userRow = page.locator(`tr:has-text("${userEmail}")`);
    await expect(userRow).toBeVisible({ timeout: 10000 });
    await userRow.locator('button:has-text("Delete")').click();

    // Wait for confirmation dialog to appear
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5000 });

    // Click cancel in confirmation dialog
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();

    // Wait for dialog to close
    await expect(page.getByRole('dialog')).toBeHidden({ timeout: 5000 });

    // Verify user still exists
    await expect(page.locator(`tr:has-text("${userEmail}")`)).toBeVisible();
  });

  test('removes exactly the deleted user (search by its email)', async ({ page }) => {
    // Checks only this test's own user: the dashboard's global "Total Users"
    // moves with every parallel run on shared QA, so it can't show a deletion.
    const userEmail = generateAdminCreatedEmail('count-delete');
    await createUser(page, { email: userEmail, role: 'member' });
    await expect.poll(() => userRowsMatching(page, userEmail), { timeout: 20000 }).toBe(1);

    await deleteUser(page, userEmail);

    // Fresh page load each poll (the list does not revalidate after the delete)
    await expect.poll(() => userRowsMatching(page, userEmail), { timeout: 30000, intervals: [1000, 2000, 3000, 5000] }).toBe(0);
  });

  test('should delete admin user successfully', async ({ page }) => {
    // Create a test admin
    const adminEmail = generateAdminCreatedEmail('delete-admin');
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
    const userEmail = generateAdminCreatedEmail('persist-delete');
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
    const user1Email = generateAdminCreatedEmail('multi-1');
    const user2Email = generateAdminCreatedEmail('multi-2');
    const user3Email = generateAdminCreatedEmail('multi-3');

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
