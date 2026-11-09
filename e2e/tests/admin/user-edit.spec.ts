/**
 * E2E Test: Admin User Editing
 *
 * Tests editing existing users via the admin dashboard.
 */

import { test, expect } from '@playwright/test';
import { loginAdmin } from '../../fixtures/admin';
import { createUser, editUser } from '../../fixtures/admin';
import { TEST_USERS, generateTestEmail } from '../../utils/test-data';

// Signs in with the test password / one-time codes (or sends test secrets in headers):
// traces would record them, so none for this file. See e2e/utils/secret-input.ts.
test.use({ trace: 'off' });

test.describe('Admin User Editing', () => {
  // beforeEach signs a brand-new admin up through the real UI on QA (register,
  // emailed code, promote, fresh OAuth): about 18 s on a busy QA, which left
  // too little of the 30 s default for the test itself.
  test.describe.configure({ timeout: 90_000 });

  test.beforeEach(async ({ page }) => {
    // Login as admin
    await loginAdmin(page, TEST_USERS.admin().email);
  });

  test('should edit user email address', async ({ page }) => {
    // Create a test user
    const originalEmail = generateTestEmail('original');
    await createUser(page, { email: originalEmail, role: 'member' });

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
    await createUser(page, { email: userEmail, role: 'member' });

    // Edit user role
    await editUser(page, userEmail, { role: 'admin' });

    // Verify role updated in list
    // Already on /users page from previous action
    const userRow = page.locator(`tr:has-text("${userEmail}")`);
    await expect(userRow.locator('text=/admin/i')).toBeVisible();
  });

  test('should edit user role from admin to member', async ({ page }) => {
    // Create a test admin - use prefix that doesn't conflict with role names
    const adminEmail = generateTestEmail('role-change-admin');
    await createUser(page, { email: adminEmail, role: 'admin' });

    // Edit user role to member (the basic user role in the system)
    await editUser(page, adminEmail, { role: 'member' });

    // Verify role updated in list
    // Already on /users page from previous action
    const userRow = page.locator(`tr:has-text("${adminEmail}")`);
    // Look for the role badge specifically (has uppercase class) to avoid matching email text
    await expect(userRow.locator('.uppercase:text-is("Member")')).toBeVisible();
  });

  test('should edit both email and role simultaneously', async ({ page }) => {
    // Create a test user
    const originalEmail = generateTestEmail('both-change');
    await createUser(page, { email: originalEmail, role: 'member' });

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
    await createUser(page, { email: userEmail, role: 'member' });

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
    await createUser(page, { email: userEmail, role: 'member' });

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
    await createUser(page, { email: originalEmail, role: 'member' });

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
    await createUser(page, { email: user1Email, role: 'member' });
    await createUser(page, { email: user2Email, role: 'member' });

    // Try to edit user2 to have user1's email
    // Already on /users page from previous action
    const user2Row = page.locator(`tr:has-text("${user2Email}")`);
    await user2Row.locator('button:has-text("Edit")').click();

    await expect(page.locator('[role="dialog"]')).toBeVisible();

    await page.fill('input[id="email"]', user1Email);
    await page.click('button[type="submit"]:has-text("Save")');

    // Verify error message (OpenAuth returns "Email '...' is already registered")
    // Look specifically in the dialog for the error message to avoid matching user emails
    await expect(
      page.locator('[role="dialog"]').locator('[role="alert"], .text-red-500, .text-destructive').filter({ hasText: /already registered|already exists/i })
    ).toBeVisible({ timeout: 10000 });
  });
});
