/**
 * E2E Test: User Count Verification (Serial)
 *
 * This test verifies dashboard user count updates after create/delete operations.
 * It MUST run serially (not in parallel with other user tests) because it relies
 * on global user counts which are affected by concurrent test operations.
 *
 * This file is excluded from sharded E2E runs and runs in a dedicated serial job.
 */

import { test, expect } from '@playwright/test';
import { loginAdmin } from '../../fixtures/admin';
import { createUser, deleteUser, navigateToAdmin } from '../../fixtures/admin';
import { TEST_USERS, TEST_URLS, generateTestEmail } from '../../utils/test-data';

// Mark entire file as serial - tests in this file run one at a time
test.describe.configure({ mode: 'serial' });

test.describe('User Count Verification (Serial)', () => {
  test.beforeEach(async ({ page }) => {
    await loginAdmin(page, TEST_USERS.admin().email);
  });

  test('should update user count after deletion', async ({ page }) => {
    // This test verifies dashboard stats update after user operations
    test.setTimeout(90000); // 90 seconds for this test

    // Navigate to dashboard to get initial count
    await navigateToAdmin(page);
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

    // Get user count from dashboard card
    const getUserCount = async (): Promise<number> => {
      await expect(page.locator('text=Total Users')).toBeVisible({ timeout: 5000 });

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
    const userEmail = generateTestEmail('count-serial');
    await createUser(page, { email: userEmail, role: 'member' });

    // Navigate to dashboard and verify count increased
    await page.goto(TEST_URLS.adminDashboard);
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

    // Verify count increased after creation
    let countAfterCreate = initialCount;
    await expect(async () => {
      await page.reload({ waitUntil: 'networkidle' });
      countAfterCreate = await getUserCount();
      expect(countAfterCreate).toBeGreaterThan(initialCount);
    }).toPass({ timeout: 30000, intervals: [2000, 3000, 5000] });

    // Delete the user
    await deleteUser(page, userEmail);

    // Navigate back to dashboard
    await page.goto(TEST_URLS.adminDashboard, { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'networkidle' });

    // Verify count decreased after deletion
    await expect(async () => {
      await page.reload({ waitUntil: 'networkidle' });
      const countAfterDelete = await getUserCount();
      expect(countAfterDelete).toBeLessThan(countAfterCreate);
    }).toPass({ timeout: 30000, intervals: [2000, 3000, 5000, 7000] });
  });
});
