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
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { register } from '../../fixtures/auth';
import { setupEmailInterception } from '../../utils/email-interceptor';
import { fillSecret } from '../../utils/secret-input';
import { TEST_PASSWORD } from '../../utils/test-credentials';
import { TEST_URLS, generateTestEmail } from '../../utils/test-data';

test.use({ trace: 'off' });

const AUTH_APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../apps/auth');
const isLocal = /^http:\/\/localhost[:/]/.test(TEST_URLS.authServer);

test.skip(({ browserName }) => browserName !== 'chromium' || !isLocal, 'virtual authenticator: Chromium on the local stack only');

/** A platform authenticator with user verification, as a phone or laptop has. */
async function addVirtualAuthenticator(context: BrowserContext, page: Page): Promise<void> {
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
}

/** Keyed deletes of one account and everything passkey-related on the local D1. */
function deleteLocalAccount(email: string): void {
  const e = email.replace(/'/g, "''");
  const uid = `(SELECT id FROM users WHERE email = '${e}')`;
  const sql = [
    `DELETE FROM webauthn_credentials WHERE user_id = ${uid}`,
    `DELETE FROM webauthn_prompts WHERE user_id = ${uid}`,
    `DELETE FROM passkey_setup_tickets WHERE user_id = ${uid}`,
    `DELETE FROM account_sessions WHERE user_id = ${uid}`,
    `DELETE FROM refresh_tokens WHERE user_id = ${uid}`,
    `DELETE FROM user_identities WHERE user_id = ${uid}`,
    `DELETE FROM rbac_user_roles WHERE user_id = ${uid}`,
    `DELETE FROM users WHERE email = '${e}'`,
    `DELETE FROM password_codes WHERE email = '${e}'`,
  ].join('; ');
  try {
    execFileSync('npx', ['wrangler', 'd1', 'execute', 'AUTH_DB', '--local', '--command', sql], { cwd: AUTH_APP, stdio: 'pipe' });
  } catch (error) {
    console.warn(`Could not delete ${email}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
  }
}

/** Sign-up through the form, stopping where the after-sign-in card shows. */
async function signUpToCard(page: Page, email: string): Promise<void> {
  const inbox = setupEmailInterception();
  await page.goto(TEST_URLS.profileApp);
  await expect(page).toHaveURL(new RegExp(TEST_URLS.authServer));
  await page.click('a:has-text("Register")');
  await page.fill('input[type="email"]', email);
  const passwords = page.locator('input[type="password"]');
  await fillSecret(passwords.nth(0), TEST_PASSWORD);
  await fillSecret(passwords.nth(1), TEST_PASSWORD);
  await page.click('button:has-text("Continue")');
  await expect(page.locator('input[name="code"]')).toBeVisible({ timeout: 20000 });
  const code = await inbox.getLastLoginCode(email);
  if (!code) throw new Error('No verification code in the local sink');
  await fillSecret(page.locator('input[name="code"]').first(), code);
  await page.click('button:has-text("Continue")');
  await expect(page.locator('[data-page="passkey"]')).toBeVisible({ timeout: 20000 });
}

/** Sign out of the profile app, drop every cookie and open it again (it sends the browser to sign-in). */
async function signOutClean(page: Page, context: BrowserContext): Promise<void> {
  await Promise.all([
    page.waitForURL(new RegExp(TEST_URLS.authServer), { timeout: 15000, waitUntil: 'commit' }),
    page.locator('#loggedInView button:has-text("Sign Out")').first().click(),
  ]);
  await context.clearCookies();
  await page.goto(TEST_URLS.profileApp);
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
  });
});
