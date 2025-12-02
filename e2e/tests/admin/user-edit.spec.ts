/**
 * E2E Test: Admin User Editing
 *
 * Tests editing existing users via the admin dashboard.
 */

import { test, expect } from '@playwright/test';
import { loginAdmin } from '../../fixtures/admin';
import { createUser, editUser } from '../../fixtures/admin';
import { TEST_USERS, generateTestEmail } from '../../utils/test-data';

test.describe('Admin User Editing', () => {
  test.beforeEach(async ({ page }) => {
    // Login as admin
    await loginAdmin(page, TEST_USERS.admin().email);
  });

  test('should edit user email address', async ({ page }) => {
    // Create a test user
    const originalEmail = generateTestEmail('original');
    await createUser(page, { email: originalEmail, role: 'user' });

    // Edit user email
    const newEmail = generateTestEmail('updated');
    await editUser(page, originalEmail, { email: newEmail });

    // Verify updated email appears in list
    // Already on /users page from previous action
    await expect(page.locator(`tr:has-text("${newEmail}")`)).toBeVisible();

    // Verify old email is gone
    await expect(
      page.locator(`tr:has-text("${originalEmail}")`)
    ).not.toBeVisible();
  });

  test('should edit user role from user to admin', async ({ page }) => {
    // Create a test user
    const userEmail = generateTestEmail('role-change');
    await createUser(page, { email: userEmail, role: 'user' });

    // Edit user role
    await editUser(page, userEmail, { role: 'admin' });

    // Verify role updated in list
    // Already on /users page from previous action
    const userRow = page.locator(`tr:has-text("${userEmail}")`);
    await expect(userRow.locator('text=/admin/i')).toBeVisible();
  });

  test('should edit user role from admin to user', async ({ page }) => {
    // Create a test admin
    const adminEmail = generateTestEmail('admin-to-user');
    await createUser(page, { email: adminEmail, role: 'admin' });

    // Edit user role
    await editUser(page, adminEmail, { role: 'user' });

    // Verify role updated in list
    // Already on /users page from previous action
    const userRow = page.locator(`tr:has-text("${adminEmail}")`);
    await expect(userRow.locator('text=/^user$/i')).toBeVisible();
  });

  test('should edit both email and role simultaneously', async ({ page }) => {
    // Create a test user
    const originalEmail = generateTestEmail('both-change');
    await createUser(page, { email: originalEmail, role: 'user' });

    // Edit both fields
    const newEmail = generateTestEmail('both-updated');
    await editUser(page, originalEmail, { email: newEmail, role: 'admin' });

    // Verify both updated
    // Already on /users page from previous action
    const userRow = page.locator(`tr:has-text("${newEmail}")`);
    await expect(userRow).toBeVisible();
    await expect(userRow.locator('text=/admin/i')).toBeVisible();
  });

  test('should show validation error for invalid email format', async ({
    page,
  }) => {
    // Create a test user
    const userEmail = generateTestEmail('validation-test');
    await createUser(page, { email: userEmail, role: 'user' });

    // Try to edit with invalid email
    // Already on /users page from previous action
    const userRow = page.locator(`tr:has-text("${userEmail}")`);
    await userRow.locator('button:has-text("Edit")').click();

    await expect(page.locator('[role="dialog"]')).toBeVisible();

    await page.fill('input[id="email"]', 'not-an-email');
    await page.click('button[type="submit"]:has-text("Save")');

    // Verify validation error
    await expect(page.locator('input[id="email"]:invalid')).toBeVisible();
  });

  test('should cancel edit without saving changes', async ({ page }) => {
    // Create a test user
    const userEmail = generateTestEmail('cancel-test');
    await createUser(page, { email: userEmail, role: 'user' });

    // Open edit dialog
    // Already on /users page from previous action
    const userRow = page.locator(`tr:has-text("${userEmail}")`);
    await userRow.locator('button:has-text("Edit")').click();

    await expect(page.locator('[role="dialog"]')).toBeVisible();

    // Make changes but don't save
    await page.fill('input[id="email"]', generateTestEmail('cancelled'));

    // Click cancel
    await page.click('button:has-text("Cancel")');

    // Verify dialog closed
    await expect(page.locator('[role="dialog"]')).not.toBeVisible();

    // Verify original email still in list
    await expect(page.locator(`tr:has-text("${userEmail}")`)).toBeVisible();
  });

  test('should persist changes after page reload', async ({ page }) => {
    // Create a test user
    const originalEmail = generateTestEmail('persist-test');
    await createUser(page, { email: originalEmail, role: 'user' });

    // Edit user
    const newEmail = generateTestEmail('persisted');
    await editUser(page, originalEmail, { email: newEmail });

    // Reload page
    await page.reload();

    // Verify changes persisted
    await expect(page.locator(`tr:has-text("${newEmail}")`)).toBeVisible();
  });

  test('should not allow editing to duplicate email', async ({ page }) => {
    // Create two test users
    const user1Email = generateTestEmail('user1');
    const user2Email = generateTestEmail('user2');
    await createUser(page, { email: user1Email, role: 'user' });
    await createUser(page, { email: user2Email, role: 'user' });

    // Try to edit user2 to have user1's email
    // Already on /users page from previous action
    const user2Row = page.locator(`tr:has-text("${user2Email}")`);
    await user2Row.locator('button:has-text("Edit")').click();

    await expect(page.locator('[role="dialog"]')).toBeVisible();

    await page.fill('input[id="email"]', user1Email);
    await page.click('button[type="submit"]:has-text("Save")');

    // Verify error message
    await expect(
      page.locator('text=/already exists|duplicate/i')
    ).toBeVisible({ timeout: 5000 });
  });
});
