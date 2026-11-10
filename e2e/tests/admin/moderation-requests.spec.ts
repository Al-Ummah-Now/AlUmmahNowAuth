/**
 * E2E: moderation requests (docs/MODERATION_REQUESTS.md).
 *
 * The videos admin's client files requests over the client API (HTTP Basic,
 * E2E_MODERATION_CLIENT_SECRET = the QA secret of client d7464de8-…); an auth
 * admin decides in the admin dashboard; the client polls the status.
 *   approve "sign out everywhere" -> queued -> actioned, the user's sign-ins end
 *   reject with a note           -> rejected, the client sees the note
 * The subject user is created for the test and deleted at the end.
 */
import { test, expect, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { loginAdmin, deleteUser } from '../../fixtures/admin';
import { register } from '../../fixtures/auth';
import { TEST_URLS, TEST_USERS, generateTestEmail } from '../../utils/test-data';

// Sends the client secret in headers and signs in with test passwords: no traces
test.use({ trace: 'off' });

const CLIENT_ID = process.env.E2E_MODERATION_CLIENT_ID || 'd7464de8-363d-4fc1-b1af-7c71653f0afc';
const CLIENT_SECRET = process.env.E2E_MODERATION_CLIENT_SECRET || '';
const basic = () => `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`;

async function fileRequest(api: APIRequestContext, subjectId: string, action: string, reason: string) {
	const res = await api.post(`${TEST_URLS.authServer}/moderation/requests`, {
		headers: { Authorization: basic(), 'Idempotency-Key': `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}` },
		data: {
			subject_user_id: subjectId,
			action,
			reason_category: 'spam',
			reason,
			evidence: [{ url: 'https://admin.qa.alummahnow.net/users', label: 'E2E evidence' }],
			requested_by: { id: 'e2e-videos-admin', display_name: 'E2E Videos Admin' },
		},
	});
	expect(res.status(), await res.text()).toBe(201);
	return ((await res.json()) as { request: { id: string } }).request.id;
}

async function clientStatus(api: APIRequestContext, id: string) {
	const res = await api.get(`${TEST_URLS.authServer}/moderation/requests/${id}`, { headers: { Authorization: basic() } });
	expect(res.status()).toBe(200);
	return ((await res.json()) as { request: { status: string; decision_note: string | null } }).request;
}

/** A fresh, signed-in member in its own browser context; returns its auth user id. */
async function createSubject(browser: Browser): Promise<{ id: string; email: string; page: Page }> {
	const context = await browser.newContext();
	const page = await context.newPage();
	const email = generateTestEmail('moderation-subject');
	await register(page, email);
	const res = await page.request.get(`${TEST_URLS.authServer}/session/accounts`);
	const { accounts } = (await res.json()) as { accounts: Array<{ userId: string; email: string }> };
	const me = accounts.find((a) => a.email.toLowerCase() === email.toLowerCase());
	if (!me) throw new Error('The new user has no auth session');
	return { id: me.userId, email, page };
}

async function decide(page: Page, requestId: string, button: string, note?: string) {
	await page.goto(`${TEST_URLS.adminDashboard}/moderation/${requestId}`);
	await expect(page.getByTestId('moderation-status')).toBeVisible({ timeout: 15000 });
	if (note) await page.locator('textarea#note').fill(note);
	page.once('dialog', (dialog) => dialog.accept());
	await page.getByRole('button', { name: button }).click();
}

test.describe('Moderation requests', () => {
	test.describe.configure({ timeout: 210_000, mode: 'serial' });
	test.skip(!CLIENT_SECRET, 'E2E_MODERATION_CLIENT_SECRET is not set');

	test('approve: the queue shows it, approval runs the action, the client sees actioned', async ({ page, browser, request }) => {
		const subject = await createSubject(browser);
		try {
			const id = await fileRequest(request, subject.id, 'revoke_sessions', 'E2E: sign this user out everywhere');
			expect((await clientStatus(request, id)).status).toBe('pending');

			await loginAdmin(page, TEST_USERS.admin().email);
			await page.goto(`${TEST_URLS.adminDashboard}/moderation?status=pending`);
			const row = page.locator(`[data-testid="moderation-row"][data-request-id="${id}"]`);
			await expect(row).toBeVisible({ timeout: 15000 });
			await expect(row).toContainText(subject.email);
			await expect(row).toContainText('Sign out everywhere');

			await decide(page, id, 'Approve and run', 'E2E approved');
			// The action runs from the moderation-actions queue; the page refreshes itself while it is queued
			await expect(page.getByTestId('moderation-status')).toHaveText('Actioned', { timeout: 90000 });
			await expect(page.getByTestId('moderation-action-failed')).toHaveCount(0);
			await expect(page.getByTestId('moderation-history')).toContainText('actioned');

			const seen = await clientStatus(request, id);
			expect(seen).toMatchObject({ status: 'actioned', decision_note: 'E2E approved' });

			// The action really ran: the user's auth session in its browser is gone
			await expect
				.poll(async () => {
					const res = await subject.page.request.get(`${TEST_URLS.authServer}/session/accounts`);
					const { accounts } = (await res.json()) as { accounts: Array<{ userId: string }> };
					return accounts.some((a) => a.userId === subject.id);
				}, { timeout: 15000 })
				.toBe(false);
		} finally {
			await subject.page.context().close();
			if (page.url().startsWith(TEST_URLS.adminDashboard)) await deleteUser(page, subject.email).catch(() => {});
		}
	});

	test('reject: a note is required and the client sees it', async ({ page, browser, request }) => {
		const subject = await createSubject(browser);
		try {
			const id = await fileRequest(request, subject.id, 'suspend_account', 'E2E: please suspend');
			await loginAdmin(page, TEST_USERS.admin().email);
			await decide(page, id, 'Reject');
			await expect(page.getByRole('alert')).toContainText('note', { timeout: 10000 });
			await decide(page, id, 'Reject', 'E2E: not enough evidence');
			await expect(page.getByTestId('moderation-status')).toHaveText('Rejected', { timeout: 20000 });
			expect(await clientStatus(request, id)).toMatchObject({ status: 'rejected', decision_note: 'E2E: not enough evidence' });
			// The account was not suspended
			await page.goto(`${TEST_URLS.adminDashboard}/moderation/${id}`);
			await expect(page.getByText('Status:')).toContainText('active');
		} finally {
			await subject.page.context().close();
			if (page.url().startsWith(TEST_URLS.adminDashboard)) await deleteUser(page, subject.email).catch(() => {});
		}
	});
});
