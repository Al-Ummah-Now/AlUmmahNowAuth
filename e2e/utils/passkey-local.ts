/**
 * Local-stack helpers for the passkey specs (Chromium virtual authenticator,
 * keyed deletes and SQL on the local D1). Never used against QA/stage.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type BrowserContext, type CDPSession, type Page } from '@playwright/test';
import { setupEmailInterception } from './email-interceptor';
import { fillSecret } from './secret-input';
import { TEST_PASSWORD } from './test-credentials';
import { TEST_URLS } from './test-data';

const AUTH_APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../apps/auth');

export const isLocalStack = /^http:\/\/localhost[:/]/.test(TEST_URLS.authServer);

/** A platform authenticator with user verification, as a phone or laptop has. */
export async function addVirtualAuthenticator(context: BrowserContext, page: Page): Promise<{ cdp: CDPSession; authenticatorId: string }> {
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return { cdp, authenticatorId };
}

/** Runs SQL on the local D1 (keyed statements only). */
export function localSql(sql: string): string {
  return execFileSync('npx', ['wrangler', 'd1', 'execute', 'AUTH_DB', '--local', '--json', '--command', sql], { cwd: AUTH_APP, stdio: 'pipe' }).toString();
}

/** Keyed deletes of one account and everything passkey-related on the local D1. */
export function deleteLocalAccount(email: string): void {
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
    localSql(sql);
  } catch (error) {
    console.warn(`Could not delete ${email}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
  }
}

/** Sign-up through the form, stopping where the after-sign-in card shows. */
export async function signUpToCard(page: Page, email: string): Promise<void> {
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
export async function signOutClean(page: Page, context: BrowserContext): Promise<void> {
  await Promise.all([
    page.waitForURL(new RegExp(TEST_URLS.authServer), { timeout: 15000, waitUntil: 'commit' }),
    page.locator('#loggedInView button:has-text("Sign Out")').first().click(),
  ]);
  await context.clearCookies();
  await page.goto(TEST_URLS.profileApp);
}
