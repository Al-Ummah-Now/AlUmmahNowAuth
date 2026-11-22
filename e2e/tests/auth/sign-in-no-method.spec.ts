/**
 * E2E: an account with no sign-in method yet (docs/USER_INVITES.md "No sign-in method yet"):
 * an invited account that skipped (or failed) the passkey has no password and no passkey.
 *
 * - The sign-in page never asks it for a password: once the email is typed, it offers
 *   "Email me a sign-in link" and "Add a password".
 * - "Email me a sign-in link": the single-use link reaches the inbox, signs in, and offers the
 *   passkey card again; Skip there says how to sign in next time, then Continue goes on.
 * - "Add a password": register (setup=1) with the email filled in; the emailed code proves the
 *   inbox, then the password is set and the account signs in with it.
 * - The passkey card: two failures make the second button "Continue without a passkey", and
 *   leaving after a failure never snoozes the card.
 *
 * Local stack only, like invites.spec.ts: each test writes its own account and invite straight
 * into the local D1, reads the sunk link or code from the local KV, and deletes everything after.
 */
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';
import { TEST_URLS } from '../../utils/test-data';

test.use({ trace: 'off' });

const AUTH_APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../apps/auth');
const AUTH = TEST_URLS.authServer;
const isLocal = /^http:\/\/localhost[:/]/.test(AUTH);
test.skip(!isLocal, 'writes accounts straight into the local D1: local stack only');

const PROFILE = { id: '109a1087-6626-40f7-8a7f-7f42f83f4f30', redirect: 'http://localhost:3302/callback' };
const hex = (n: number) => randomBytes(n).toString('hex');
const sql = (s: string) => `'${s.replace(/'/g, "''")}'`;
const wrangler = (args: string[]) => execFileSync('npx', ['wrangler', ...args, '--local', '-c', 'wrangler.dev.json'], { cwd: AUTH_APP, stdio: 'pipe' }).toString();

function d1(command: string): string {
  for (let attempt = 1; ; attempt++) {
    try {
      return wrangler(['d1', 'execute', 'AUTH_DB', '--json', '--command', command]);
    } catch (err) {
      const busy = /SQLITE_BUSY|database is locked/.test(String((err as { stderr?: Buffer }).stderr ?? err));
      if (!busy || attempt >= 10) throw err;
      execFileSync('sleep', [String(Math.min(attempt, 4))]);
    }
  }
}
const d1Rows = <T>(command: string): T[] => (JSON.parse(d1(command)) as Array<{ results: T[] }>)[0]?.results ?? [];
const kvGet = (key: string): string | null => {
  try {
    return wrangler(['kv', 'key', 'get', '--binding', 'AUTH_STORAGE', key]);
  } catch {
    return null;
  }
};
const kvDelete = (key: string) => {
  try {
    wrangler(['kv', 'key', 'delete', '--binding', 'AUTH_STORAGE', key]);
  } catch {
    // already gone
  }
};

interface Seeded {
  email: string;
  userId: string;
  inviteId: string;
  link: string;
}
const created: Seeded[] = [];

/** An invited account that already accepted (active) with no password and no passkey, and its invite. */
function seedNoMethodAccount(): Seeded {
  const userId = `usr_${hex(16)}`;
  const inviteId = `inv_${hex(16)}`;
  const email = `no-method-${hex(5)}@e2e.alummahnow.net`;
  const token = hex(32);
  const hash = createHash('sha256').update(token).digest('hex');
  const now = Date.now();
  const metadata = JSON.stringify({ email_verified: true, invited: true, invited_at: now, invite_id: inviteId });
  d1(
    [
      `INSERT INTO users (id, tenant_id, email, name, metadata, status, created_at, updated_at, password_reset_required) VALUES (${sql(userId)}, 'default', ${sql(email)}, 'Maryam Siddiqui', ${sql(metadata)}, 'active', ${now}, ${now}, 0)`,
      `INSERT OR IGNORE INTO rbac_user_roles (user_id, role_id, tenant_id, assigned_at, assigned_by) SELECT ${sql(userId)}, id, 'default', ${now}, 'user_system' FROM rbac_roles WHERE id = 'role_member' AND tenant_id = 'default'`,
      // The first link was used an hour ago (accepted, passkey skipped): no recent send, so a new one may go out
      `INSERT INTO user_invites (id, tenant_id, user_id, email, name, locale, note, client_id, details, continue_url, token_hash, invited_by, invited_by_email, created_at, updated_at, expires_at, last_sent_at, send_count, token_used_at, accepted_at) VALUES (${sql(inviteId)}, 'default', ${sql(userId)}, ${sql(email)}, 'Maryam Siddiqui', 'en', NULL, 'e2e-invites', '{}', ${sql(`${AUTH}/session/accounts`)}, ${sql(hash)}, 'usr_e2e_admin', NULL, ${now - 7_200_000}, ${now}, ${now + 14 * 86_400_000}, ${now - 7_200_000}, 1, ${now - 3_600_000}, ${now - 3_600_000})`,
    ].join('; ')
  );
  const seeded = { email, userId, inviteId, link: `${AUTH}/invite/${token}` };
  created.push(seeded);
  return seeded;
}

test.afterEach(() => {
  for (const s of created.splice(0)) {
    const uid = sql(s.userId);
    try {
      d1(
        [
          `DELETE FROM webauthn_credentials WHERE user_id = ${uid}`,
          `DELETE FROM webauthn_prompts WHERE user_id = ${uid}`,
          `DELETE FROM account_sessions WHERE user_id = ${uid}`,
          `DELETE FROM rbac_user_roles WHERE user_id = ${uid}`,
          `DELETE FROM user_invites WHERE id = ${sql(s.inviteId)}`,
          `DELETE FROM users WHERE id = ${uid}`,
        ].join('; ')
      );
    } catch (error) {
      console.warn(`Could not delete ${s.email}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
    }
    for (const key of [`test:invite:${s.email}`, `test:email:${s.email}`, `email::${s.email}::password`, `user::email::default::${s.email}`]) kvDelete(key);
  }
});

/** The app's sign-in for the profile client: the password sign-in page. */
async function openSignIn(page: Page): Promise<void> {
  const challenge = createHash('sha256').update(hex(32)).digest('base64url');
  await page.goto(`${AUTH}/authorize?client_id=${PROFILE.id}&response_type=code&state=s&provider=password&redirect_uri=${encodeURIComponent(PROFILE.redirect)}&code_challenge=${challenge}&code_challenge_method=S256`);
  await expect(page.locator('form[data-aun-login] input[name="email"]')).toBeVisible();
  // One field named email: every app's sign-in helper finds it by name (v2026.11.22.3)
  await expect(page.locator('input[name="email"]')).toHaveCount(1);
  await expect(page.locator('button[data-component="button"]:not([type="button"])')).toHaveCount(1);
}

/** The action signs in: the app's callback gets a code (nothing listens there), or the after-sign-in passkey card shows. */
async function signsIn(page: Page, action: () => Promise<unknown>): Promise<void> {
  const callback = page.waitForRequest(/^http:\/\/localhost:3302\/callback\?code=/, { timeout: 20_000 });
  await action();
  await Promise.race([callback, page.locator('[data-page="passkey"]').waitFor({ timeout: 20_000 })]);
}

/** Types the email and leaves the field: the page looks it up. */
async function typeEmail(page: Page, email: string): Promise<void> {
  const field = page.locator('form[data-aun-login] input[name="email"]');
  await field.fill(email);
  await field.blur();
}

test.describe('No sign-in method yet', () => {
  test.setTimeout(120_000);

  test('the sign-in page offers a link or a password, never asks for a password; the link signs in and offers a passkey again', async ({ page }) => {
    const s = seedNoMethodAccount();
    await openSignIn(page);
    await typeEmail(page, s.email);
    const options = page.getByTestId('no-password-options');
    await expect(options).toBeVisible();
    await expect(options).toContainText('This email has no password yet');
    await expect(page.locator('form[data-aun-login] input[name="password"]')).toBeHidden();

    await options.getByRole('button', { name: 'Email me a sign-in link' }).click();
    const sent = page.locator('[data-page="sign-in-link"][data-state="sent"]');
    await expect(sent).toContainText('Check your inbox');
    await expect(sent).toContainText(s.email);

    let link: string | null = null;
    await expect.poll(() => (link = (JSON.parse(kvGet(`test:invite:${s.email}`) ?? '{}') as { link?: string }).link ?? null), { timeout: 20_000 }).toBeTruthy();
    expect(link).not.toBe(s.link);
    await page.goto(link!);
    await page.locator('[data-action="accept-invite"]').click();
    const card = page.locator('[data-page="passkey"]');
    await expect(card).toBeVisible({ timeout: 15_000 });
    // Skip first says how to sign in next time, then Continue goes on
    await card.locator('[data-action="skip"]').click();
    await expect(card.locator('[data-slot="note"]')).toContainText('No passkey yet. Next time, sign in with the link we email you, or add a password.');
    await card.locator('[data-action="done"]').click();
    await page.waitForURL(`${AUTH}/session/accounts`, { timeout: 15_000 });
  });

  test('"Add a password": the emailed code proves the inbox, then the password works', async ({ page }) => {
    const s = seedNoMethodAccount();
    const password = `Aun-${hex(6)}-pass`;
    await openSignIn(page);
    await typeEmail(page, s.email);
    await page.getByTestId('no-password-options').getByRole('link', { name: 'Add a password' }).click();
    await expect(page.getByTestId('add-password-title')).toHaveText('Add a password');
    await expect(page.locator('input[name="email"]')).toHaveValue(s.email);
    await page.locator('input[name="password"]').fill(password);
    await page.locator('input[name="repeat"]').fill(password);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.locator('input[name="code"]')).toBeVisible({ timeout: 15_000 });
    let code: string | null = null;
    await expect.poll(() => (code = (JSON.parse(kvGet(`test:email:${s.email}`) ?? '{}') as { code?: string }).code ?? null), { timeout: 20_000 }).toBeTruthy();
    await page.locator('input[name="code"]').fill(code!);
    await signsIn(page, () => page.getByRole('button', { name: 'Continue' }).click());
    // The same account (no second one), and now it signs in with the password
    expect(d1Rows<{ n: number }>(`SELECT COUNT(*) AS n FROM users WHERE email = ${sql(s.email)}`)[0].n).toBe(1);
    await page.context().clearCookies();
    await openSignIn(page);
    await typeEmail(page, s.email);
    await expect(page.locator('form[data-aun-login] input[name="password"]')).toBeVisible();
    await expect(page.getByTestId('no-password-options')).toBeHidden();
    await page.locator('form[data-aun-login] input[name="password"]').fill(password);
    await signsIn(page, () => page.locator('form[data-aun-login] > button').click());
  });

  test('the passkey card: two failures make it "Continue without a passkey", and leaving never snoozes the card', async ({ page }) => {
    const s = seedNoMethodAccount();
    await page.addInitScript(() => {
      Object.defineProperty(navigator.credentials, 'create', { value: () => Promise.reject(new DOMException('The operation either timed out or was not allowed.', 'NotAllowedError')) });
    });
    await openSignIn(page);
    await typeEmail(page, s.email);
    await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
    let link: string | null = null;
    await expect.poll(() => (link = (JSON.parse(kvGet(`test:invite:${s.email}`) ?? '{}') as { link?: string }).link ?? null), { timeout: 20_000 }).toBeTruthy();
    await page.goto(link!);
    await page.locator('[data-action="accept-invite"]').click();
    const card = page.locator('[data-page="passkey"]');
    const skip = card.locator('[data-action="skip"]');
    await card.locator('[data-action="add"]').click();
    await expect(card.locator('[data-slot="note"]')).toBeVisible();
    await expect(skip).toHaveText('Skip');
    await card.locator('[data-action="add"]').click();
    await expect(skip).toHaveText('Continue without a passkey');
    await skip.click();
    await page.waitForURL(`${AUTH}/session/accounts`, { timeout: 15_000 });
    expect(d1Rows<{ dismissed_at: number }>(`SELECT dismissed_at FROM webauthn_prompts WHERE user_id = ${sql(s.userId)}`)).toEqual([]);
  });

  test('Arabic: the two options in Arabic, right to left', async ({ page }) => {
    const s = seedNoMethodAccount();
    await openSignIn(page);
    await page.goto(`${page.url()}&lang=ar`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await typeEmail(page, s.email);
    const options = page.getByTestId('no-password-options');
    await expect(options).toContainText('لا كلمة مرور لهذا البريد بعد');
    await expect(options.getByRole('button', { name: 'أرسل لي رابط تسجيل الدخول' })).toBeVisible();
    await expect(options.getByRole('link', { name: 'إضافة كلمة مرور' })).toBeVisible();
  });
});
