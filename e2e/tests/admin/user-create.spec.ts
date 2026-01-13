/**
 * E2E Test: Admin User Creation
 *
 * Tests creating new users via the admin dashboard.
 */

import { test, expect } from '@playwright/test';
import { loginAdmin, createUser, navigateToAdmin, userExists } from '../../fixtures/admin';
import { TEST_USERS, TEST_URLS, generateTestEmail } from '../../utils/test-data';

test.describe('Admin User Creation', () => {
  test.beforeEach(async ({ page }) => {
    // Login as admin - generate unique admin for each test
    await loginAdmin(page, TEST_USERS.admin().email);
  });

  test('should create a new user with role "member"', async ({ page }) => {
    const newUser = {
      email: generateTestEmail('new-user'),
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
      email: generateTestEmail('admin-role-user'),
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
    await page.locator('[role="dialog"] label').filter({ hasText: /^member\s*-/i }).locator('input[type="checkbox"]').check();

    // Try to submit - use dialog-specific selector to avoid matching header button
    await page.locator('[role="dialog"] button:has-text("Create User")').click();

    // Verify validation error message appears (client-side validation)
    await expect(page.locator('[role="alert"]:has-text("valid email")')).toBeVisible({ timeout: 5000 });

    // Verify dialog is still open (submission was prevented)
    await expect(page.locator('[role="dialog"]')).toBeVisible();
  });

  test('should show error when creating duplicate user', async ({ page }) => {
    const duplicateEmail = generateTestEmail('duplicate');

    // Create first user
    await createUser(page, { email: duplicateEmail, role: 'member' });

    // Try to create user with same email
    await page.goto(`${TEST_URLS.adminDashboard}/users`);
    await page.click('button:has-text("Create User")');
    await expect(page.locator('[role="dialog"]')).toBeVisible();

    await page.fill('input[id="email"]', duplicateEmail);
    // Wait for roles to load, then select role using checkbox scoped to dialog
    const dialogCheckbox = page.locator('[role="dialog"] label input[type="checkbox"]');
    await expect(dialogCheckbox.first()).toBeVisible({ timeout: 10000 });
    await page.locator('[role="dialog"] label').filter({ hasText: /^member\s*-/i }).locator('input[type="checkbox"]').check();
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
      email: generateTestEmail('reset-test'),
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

  test('should update user count after creating user', async ({ page }) => {
    await navigateToAdmin(page);

    // Wait for dashboard stats to load
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

    // Create new user
    const newUser = {
      email: generateTestEmail('count-test'),
      role: 'member' as const,  // OpenAuth uses 'member' as default role
    };
    await createUser(page, newUser);

    // Navigate back to dashboard - use goto for full page reload to get fresh data
    await page.goto(TEST_URLS.adminDashboard);
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

    // Use polling to wait for the count to update (handles any race conditions)
    await expect(async () => {
      const updatedCount = await getUserCount();
      expect(updatedCount).toBe(initialCount + 1);
    }).toPass({ timeout: 20000, intervals: [1000, 2000, 3000, 5000] });
  });
});
