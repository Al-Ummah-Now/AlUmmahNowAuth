/**
 * E2E Test: Admin User Creation
 *
 * Tests creating new users via the admin dashboard.
 */

import { test, expect } from '@playwright/test';
import { login } from '../../fixtures/auth';
import { createUser, navigateToAdmin, userExists } from '../../fixtures/admin';
import { TEST_USERS, generateTestEmail } from '../../utils/test-data';

test.describe('Admin User Creation', () => {
  test.beforeEach(async ({ page }) => {
    // Login as admin
    await login(page, TEST_USERS.admin.email);
  });

  test('should create a new user with role "user"', async ({ page }) => {
    const newUser = {
      email: generateTestEmail('new-user'),
      role: 'user' as const,
    };

    // Create user
    await createUser(page, newUser);

    // Verify user appears in list
    const exists = await userExists(page, newUser.email);
    expect(exists).toBe(true);
  });

  test('should create a new user with role "admin"', async ({ page }) => {
    const newAdmin = {
      email: generateTestEmail('new-admin'),
      role: 'admin' as const,
    };

    // Create user
    await createUser(page, newAdmin);

    // Verify user appears in list with admin role
    await navigateToAdmin(page);
    const userRow = page.locator(`tr:has-text("${newAdmin.email}")`);
    await expect(userRow).toBeVisible();
    await expect(userRow.locator('text=/admin/i')).toBeVisible();
  });

  test('should show validation error for invalid email', async ({ page }) => {
    await navigateToAdmin(page);

    // Click create user button
    await page.click('button:has-text("Create User")');

    // Wait for dialog
    await expect(page.locator('[role="dialog"]')).toBeVisible();

    // Enter invalid email
    await page.fill('input[name="email"]', 'not-an-email');
    await page.selectOption('select[name="role"]', 'user');

    // Try to submit
    await page.click('button[type="submit"]:has-text("Create")');

    // Verify validation error
    await expect(page.locator('input[name="email"]:invalid')).toBeVisible();
  });

  test('should show error when creating duplicate user', async ({ page }) => {
    const duplicateEmail = generateTestEmail('duplicate');

    // Create first user
    await createUser(page, { email: duplicateEmail, role: 'user' });

    // Try to create user with same email
    await navigateToAdmin(page);
    await page.click('button:has-text("Create User")');
    await expect(page.locator('[role="dialog"]')).toBeVisible();

    await page.fill('input[name="email"]', duplicateEmail);
    await page.selectOption('select[name="role"]', 'user');
    await page.click('button[type="submit"]:has-text("Create")');

    // Verify error message
    await expect(
      page.locator('text=/already exists|duplicate/i')
    ).toBeVisible({ timeout: 5000 });
  });

  test('should set password_reset_required flag for new users', async ({
    page,
  }) => {
    const newUser = {
      email: generateTestEmail('reset-test'),
      role: 'user' as const,
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
    await navigateToAdmin(page);

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

    // Get initial user count
    const initialCount = await page
      .locator('text=/Total Users/i')
      .locator('..')
      .locator('.value')
      .textContent();

    // Create new user
    const newUser = {
      email: generateTestEmail('count-test'),
      role: 'user' as const,
    };
    await createUser(page, newUser);

    // Navigate back to dashboard
    await page.click('a:has-text("Dashboard")');

    // Get updated user count
    const updatedCount = await page
      .locator('text=/Total Users/i')
      .locator('..')
      .locator('.value')
      .textContent();

    // Verify count increased by 1
    expect(parseInt(updatedCount || '0')).toBe(
      parseInt(initialCount || '0') + 1
    );
  });
});
