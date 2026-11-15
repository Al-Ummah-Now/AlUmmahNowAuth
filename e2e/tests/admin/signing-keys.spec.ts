/**
 * Admin > Signing keys (AlUmmahNowAuth#13, docs/SIGNING_KEY_ROTATION.md): an admin
 * sees the issuer's keys and their state, how rotation works and the job's last run,
 * in English and Arabic. Rotating is for Super Admins (an Admin sees why there is no
 * button); this spec never rotates, so the environment's keys stay as they are.
 * The per-run admin account is removed by the global teardown.
 */
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { loginAdmin } from '../../fixtures/admin';
import { TEST_URLS, TEST_USERS } from '../../utils/test-data';

const ADMIN = TEST_URLS.adminDashboard;

test.describe('Accounts admin: signing keys', () => {
	test.setTimeout(120000);

	test('an admin sees the keys, the policy and the job status, without key material or a rotate button', async ({ page }) => {
		await loginAdmin(page, TEST_USERS.admin().email);
		await page.goto(`${ADMIN}/signing-keys`);
		await expect(page.getByRole('heading', { name: 'Signing keys', level: 1 })).toBeVisible();

		const table = page.getByTestId('signing-keys-table');
		await expect(table).toBeVisible();
		// Exactly one key signs
		await expect(table.locator('tr[data-state="active"]')).toHaveCount(1);
		await expect(table.locator('tr[data-state="active"]')).toContainText('Signing');
		await expect(table).toContainText('ES256');
		// Only ids: no PEM or JWK material on the page
		await expect(page.locator('body')).not.toContainText('BEGIN');
		await expect(page.locator('body')).not.toContainText('"d":');

		await expect(page.getByTestId('signing-keys-policy').locator('li')).toHaveCount(3);
		await expect(page.getByTestId('signing-keys-policy')).toContainText('before it starts signing');
		await expect(page.getByTestId('signing-keys-rotate')).toHaveCount(0);
		await expect(page.getByText('Only a Super Admin can rotate keys.')).toBeVisible();

		const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
		expect(axe.violations.map((v) => v.id)).toEqual([]);
	});

	test('Arabic: right to left, every label in Arabic', async ({ page }) => {
		await loginAdmin(page, TEST_USERS.admin().email);
		await page.goto(`${ADMIN}/signing-keys?lang=ar`);
		await expect(page.getByRole('heading', { name: 'مفاتيح التوقيع', level: 1 })).toBeVisible();
		await expect(page.locator('div[dir="rtl"][lang="ar"]').first()).toBeVisible();
		await expect(page.getByTestId('signing-keys-table').locator('tr[data-state="active"]')).toContainText('يوقّع');
		await expect(page.getByText('التدوير متاح للمشرف العام فقط.')).toBeVisible();
		await expect(page.getByTestId('signing-keys-policy').locator('li')).toHaveCount(3);
		const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
		expect(axe.violations.map((v) => v.id)).toEqual([]);
	});
});
