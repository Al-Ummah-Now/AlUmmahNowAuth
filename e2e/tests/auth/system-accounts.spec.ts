/**
 * System accounts on the live QA/stage auth (apps/auth/src/security/system-accounts.ts).
 *
 * - user_system exists (its id labels automatic grants) and holds no role.
 * - It is not in the admin user list or its search, and a plain admin (not a
 *   super admin) gets no System accounts view.
 */
import { test, expect } from '@playwright/test';
import { loginAdmin } from '../../fixtures/admin';
import { TEST_URLS, TEST_USERS } from '../../utils/test-data';

// Sends test secrets in headers and signs in: no traces for this file (e2e/utils/secret-input.ts)
test.use({ trace: 'off' });

const SINK_SECRET = process.env.E2E_CODE_SINK_SECRET ?? '';

test.describe('System accounts', () => {
  test('user_system holds no role on this environment', async ({ request }) => {
    test.skip(!SINK_SECRET, 'E2E_CODE_SINK_SECRET is not set');
    const res = await request.get(`${TEST_URLS.authServer}/test/system-accounts`, { headers: { 'X-E2E-Secret': SINK_SECRET } });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { accounts: Array<{ id: string; type: string | null }>; roles: unknown[] };
    expect(body.accounts).toEqual([expect.objectContaining({ id: 'user_system', type: 'system' })]);
    expect(body.roles).toEqual([]);
  });

  test('the admin user list and its search leave it out; a plain admin has no System accounts view', async ({ page }) => {
    test.setTimeout(120_000);
    await loginAdmin(page, TEST_USERS.admin().email);
    await page.goto(`${new URL(TEST_URLS.adminDashboard).origin}/users?q=${encodeURIComponent('system@openauth.local')}`);
    await expect(page.getByRole('heading', { name: 'User Management' })).toBeVisible();
    await expect(page.locator('tr:has-text("system@openauth.local")')).toHaveCount(0);
    await expect(page.getByTestId('system-accounts-toggle')).toHaveCount(0);
    await page.goto(`${new URL(TEST_URLS.adminDashboard).origin}/users?view=system`);
    await expect(page.getByTestId('system-accounts')).toHaveCount(0);
  });
});
