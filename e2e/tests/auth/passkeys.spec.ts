/**
 * E2E: passkeys (AUTH-PASSKEYS) with a Chromium virtual authenticator.
 *
 * - The after-sign-in card adds a passkey, then continues to the app.
 * - "Sign in with a passkey" on the sign-in page signs the user in with no password.
 * - The account hub lists, renames and removes a passkey (in-app dialog, Undo).
 *
 * Local stack only (CDP WebAuthn.addVirtualAuthenticator, localhost RP): it skips
 * against deployed QA/stage. Every test signs up its own account and deletes it in
 * afterEach, pass or fail (keyed deletes on the local D1 only).
 */
import { test, expect, type Page } from '@playwright/test';
import { register } from '../../fixtures/auth';
import { addVirtualAuthenticator, deleteLocalAccount, isLocalStack, signOutClean, signUpToCard } from '../../utils/passkey-local';
import { generateTestEmail } from '../../utils/test-data';

test.use({ trace: 'off' });

test.skip(({ browserName }) => browserName !== 'chromium' || !isLocalStack, 'virtual authenticator: Chromium on the local stack only');

/**
 * The hub's Passkeys card shows no error: the list loaded (empty text or rows) and the
 * status line is not in its error tone. Catches "Something went wrong. Try again." on load.
 */
async function expectCardHealthy(page: Page): Promise<void> {
  const card = page.locator('#passkeys');
  await expect(card).toBeVisible({ timeout: 15000 });
  await expect(card.locator('#passkeysEmpty:visible, #passkeyList [data-passkey-id]').first()).toBeVisible({ timeout: 15000 });
  await expect(card.locator('#passkeyStatus[data-tone="error"]')).toHaveCount(0);
  await expect(card.locator('[data-tone="error"], .error-message')).toHaveCount(0);
}

const accounts: string[] = [];
test.afterEach(() => {
  for (const email of accounts.splice(0)) deleteLocalAccount(email);
});

test.describe('Passkeys', () => {
  test.setTimeout(120000);

  test('the after-sign-in card adds a passkey, then the passkey signs in alone', async ({ page, context }) => {
    const email = generateTestEmail('pk-card');
    accounts.push(email);
    await addVirtualAuthenticator(context, page);

    await signUpToCard(page, email);
    await page.locator('[data-page="passkey"] [data-action="add"]').click();
    const done = page.locator('[data-page="passkey"] [data-action="done"]');
    await expect(done).toBeVisible({ timeout: 15000 });
    await done.click();
    await expect(page.locator('#loggedInView')).toBeVisible({ timeout: 20000 });

    // The hub lists it
    await expect(page.locator('#passkeyList [data-passkey-id]')).toHaveCount(1, { timeout: 15000 });
    await expectCardHealthy(page);

    // Autofill (conditional UI): signed out with no cookies, the sign-in page offers the
    // passkey and the virtual authenticator (automatic presence) picks it, so the user is
    // back in the app with no password and no card
    await signOutClean(page, context);
    await expect(page.locator('#loggedInView')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('[data-page="passkey"]')).toHaveCount(0);

    // The button, on a browser without conditional UI
    await context.addInitScript(() => {
      if (window.PublicKeyCredential) PublicKeyCredential.isConditionalMediationAvailable = () => Promise.resolve(false);
    });
    await signOutClean(page, context);
    await expect(page.locator('input[type="email"]')).toBeVisible({ timeout: 15000 });
    await page.locator('[data-passkey-button]').click();
    await expect(page.locator('#loggedInView')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('[data-page="passkey"]')).toHaveCount(0);
  });

  test('the account hub adds, renames and removes a passkey with Undo', async ({ page, context }) => {
    const email = generateTestEmail('hub');
    accounts.push(email);
    await addVirtualAuthenticator(context, page);
    await register(page, email);

    const rows = page.locator('#passkeyList [data-passkey-id]');
    await expect(page.locator('#passkeysEmpty')).toBeVisible({ timeout: 15000 });
    await expectCardHealthy(page);
    // "Add a passkey" opens the Auth setup page; the passkey is made there, then Continue comes back
    await page.locator('#passkeyAdd').click();
    await expect(page.locator('[data-page="passkey"]')).toBeVisible({ timeout: 15000 });
    await page.locator('[data-page="passkey"] [data-action="add"]').click();
    const done = page.locator('[data-page="passkey"] [data-action="done"]');
    await expect(done).toBeVisible({ timeout: 15000 });
    await done.click();
    await expect(page.locator('#loggedInView')).toBeVisible({ timeout: 20000 });
    await expect(rows).toHaveCount(1, { timeout: 15000 });

    // Rename
    await rows.first().getByRole('button', { name: /^Rename/ }).click();
    const nameInput = page.getByRole('textbox', { name: 'Passkey name' });
    await nameInput.fill('Work laptop');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(rows.first().locator('.passkey-name')).toHaveText('Work laptop', { timeout: 10000 });

    // Remove asks in an in-app dialog, then offers Undo
    await rows.first().getByRole('button', { name: /^Remove/ }).click();
    const dialog = page.locator('#confirmDialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Remove this passkey?');
    await dialog.locator('#confirmAction').click();
    await expect(rows).toHaveCount(0, { timeout: 10000 });
    await page.locator('#passkeyUndo').click();
    await expect(rows).toHaveCount(1, { timeout: 10000 });
    await expect(rows.first().locator('.passkey-name')).toHaveText('Work laptop');

    // The restored passkey persists across a reload
    await page.reload();
    await expect(rows).toHaveCount(1, { timeout: 15000 });
    await expectCardHealthy(page);
  });
});
