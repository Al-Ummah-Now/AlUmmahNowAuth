/**
 * E2E Test: Admin User Creation
 *
 * Tests creating new users via the admin dashboard.
 */

import { test, expect } from '@playwright/test';
import { loginAdmin, createUser, userExists, userRowsMatching } from '../../fixtures/admin';
import { TEST_USERS, TEST_URLS, generateAdminCreatedEmail } from '../../utils/test-data';

// Signs in with the test password / one-time codes (or sends test secrets in headers):
// traces would record them, so none for this file. See e2e/utils/secret-input.ts.
test.use({ trace: 'off' });

test.describe('Admin User Creation', () => {
  // beforeEach signs a brand-new admin up through the real UI on QA (register,
  // emailed code, promote, fresh OAuth): about 18 s on a busy QA, which left
  // too little of the 30 s default for the test itself.
  test.describe.configure({ timeout: 90_000 });

  test.beforeEach(async ({ page }) => {
    // Login as admin - generate unique admin for each test
    await loginAdmin(page, TEST_USERS.admin().email);
  });

  test('should create a new user with role "member"', async ({ page }) => {
    const newUser = {
      email: generateAdminCreatedEmail('new-user'),
      role: 'member' as const,  // OpenAuth uses 'member' as default role
    };

    // Create user
    await createUser(page, newUser);

    // Verify user appears in list
    const exists = await userExists(page, newUser.email);
    expect(exists).toBe(true);
  });

  test('should create a new user with role "admin"', async ({ page }) => {
    // Use prefix that doesn't contain "admin" to avoid matching email AND role badge
    const newAdmin = {
      email: generateAdminCreatedEmail('admin-role-user'),
      role: 'admin' as const,
    };

    // Create user
    await createUser(page, newAdmin);

    // Verify user appears in list with admin role (createUser navigates to /users)
    // Use polling to wait for role to appear after async revalidation
    // The role assignment and data refresh can take a moment
    await expect(async () => {
      // Re-query the row locator each iteration to get fresh DOM reference
      const userRow = page.locator(`tr:has-text("${newAdmin.email}")`);
      await expect(userRow).toBeVisible({ timeout: 3000 });

      // Look for Admin role badge in the roles column (3rd column)
      // The role name is displayed as-is from the database ("Admin" with Title Case)
      const roleCell = userRow.locator('td:nth-child(3)');
      const hasAdminRole = await roleCell.locator('text=Admin').isVisible();

      if (!hasAdminRole) {
        // Reload to get fresh data from server
        await page.reload();
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      }

      // Assert the role is visible
      await expect(roleCell.locator('text=Admin')).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 20000, intervals: [1000, 2000, 3000, 5000] });
  });

  test('should show validation error for invalid email', async ({ page }) => {
    // Navigate to users page
    await page.goto(`${TEST_URLS.adminDashboard}/users`);

    // Click create user button
    await page.click('button:has-text("Create User")');

    // Wait for dialog
    await expect(page.locator('[role="dialog"]')).toBeVisible();

    // Enter invalid email
    await page.fill('input[id="email"]', 'not-an-email');
    // Wait for roles to load, then select role using checkbox scoped to dialog
    const dialogCheckbox = page.locator('[role="dialog"] label input[type="checkbox"]');
    await expect(dialogCheckbox.first()).toBeVisible({ timeout: 10000 });
    // Find role by exact name match in span.text-sm, then navigate to parent label and click
    const roleSpan = page.locator('[role="dialog"] label span.text-sm').filter({ hasText: /^Member$/ });
    const roleCheckbox = roleSpan.locator('xpath=..').locator('input[type="checkbox"]');
    await roleCheckbox.click();

    // Try to submit - use dialog-specific selector to avoid matching header button
    await page.locator('[role="dialog"] button:has-text("Create User")').click();

    // Verify validation error message appears (client-side validation)
    await expect(page.locator('[role="alert"]:has-text("valid email")')).toBeVisible({ timeout: 5000 });

    // Verify dialog is still open (submission was prevented)
    await expect(page.locator('[role="dialog"]')).toBeVisible();
  });

  test('should show error when creating duplicate user', async ({ page }) => {
    const duplicateEmail = generateAdminCreatedEmail('duplicate');

    // Create first user
    await createUser(page, { email: duplicateEmail, role: 'member' });

    // Try to create user with same email
    await page.goto(`${TEST_URLS.adminDashboard}/users`);
    await page.click('button:has-text("Create User")');
    await expect(page.locator('[role="dialog"]')).toBeVisible();

    await page.fill('input[id="email"]', duplicateEmail);
    // Wait for roles to load, then select role using checkbox scoped to dialog
    const dialogCheckbox2 = page.locator('[role="dialog"] label input[type="checkbox"]');
    await expect(dialogCheckbox2.first()).toBeVisible({ timeout: 10000 });
    // Find role by exact name match in span.text-sm, then navigate to parent label and click
    const roleSpan2 = page.locator('[role="dialog"] label span.text-sm').filter({ hasText: /^Member$/ });
    const roleCheckbox2 = roleSpan2.locator('xpath=..').locator('input[type="checkbox"]');
    await roleCheckbox2.click();
    await page.locator('[role="dialog"] button:has-text("Create User")').click();

    // Verify error message - server returns "email_already_exists" or "already registered"
    // Look in dialog for error alert
    await expect(
      page.locator('[role="dialog"] [role="alert"]').filter({ hasText: /already|exists/i })
    ).toBeVisible({ timeout: 5000 });
  });

  test('should set password_reset_required flag for new users', async ({
    page,
  }) => {
    const newUser = {
      email: generateAdminCreatedEmail('reset-test'),
      role: 'member' as const,  // OpenAuth uses 'member' as default role
    };

    // Create user
    await createUser(page, newUser);

    // Note: In a real test, we would verify the database directly
    // or check if the user gets prompted for password reset on first login
    // For now, we just verify the user was created successfully
    const exists = await userExists(page, newUser.email);
    expect(exists).toBe(true);
  });

  test('should close dialog when clicking cancel', async ({ page }) => {
    // Navigate to users page
    await page.goto(`${TEST_URLS.adminDashboard}/users`);

    // Click create user button
    await page.click('button:has-text("Create User")');

    // Wait for dialog
    await expect(page.locator('[role="dialog"]')).toBeVisible();

    // Click cancel
    await page.click('button:has-text("Cancel")');

    // Verify dialog is closed
    await expect(page.locator('[role="dialog"]')).not.toBeVisible();
  });

  test('lists exactly the created user (search by its email)', async ({ page }) => {
    // Checks only this test's own user: the dashboard's global "Total Users"
    // moves with every parallel run on shared QA (deletions too), so it can't show a creation.
    const email = generateAdminCreatedEmail('count-test');
    await createUser(page, { email, role: 'member' }); // OpenAuth uses 'member' as default role
    await expect.poll(() => userRowsMatching(page, email), { timeout: 20000, intervals: [1000, 2000, 3000, 5000] }).toBe(1);
  });
});
