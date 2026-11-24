/**
 * Admin > Account events (AlUmmahNowAuth#507) is off in every environment: no link in the rail
 * and no page. The page itself: apps/admin/app/routes/account-events.test.tsx and the hydration
 * check. The per-run admin account is removed by the global teardown.
 */
import { test, expect } from '@playwright/test';
import { loginAdmin } from '../../fixtures/admin';
import { TEST_URLS, TEST_USERS } from '../../utils/test-data';

test('Accounts admin: no account events while they are off', async ({ page }) => {
	test.setTimeout(120000);
	await loginAdmin(page, TEST_USERS.admin().email);
	await page.goto(`${TEST_URLS.adminDashboard}/signing-keys`);
	await expect(page.locator('#admin-rail a[href="/signing-keys"]')).toBeAttached();
	await expect(page.locator('#admin-rail a[href="/account-events"]')).toHaveCount(0);
	const response = await page.goto(`${TEST_URLS.adminDashboard}/account-events`);
	expect(response?.status()).toBe(404);
});
