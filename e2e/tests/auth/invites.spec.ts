/**
 * E2E: the invite link (docs/USER_INVITES.md "The link"), one test per state:
 *
 * - fresh link: "Your account is ready" → Continue → passkey offer → Skip → the
 *   app, signed in as the invited account (active), no password anywhere;
 * - fresh link + a passkey added on the offer (virtual authenticator);
 * - other accounts already signed in: no extra step, the invited account joins
 *   them and is the active one, the others stay signed in;
 * - second click (no password or passkey yet): "Finish setting up", never
 *   "sign in"; "Email me a new link" emails a fresh link that signs in again;
 * - expired (never used): "Finish setting up";
 * - account already set up (a passkey): "You're already set up" + Sign in;
 * - revoked: "This invite was withdrawn"; unknown link: "This link doesn't work";
 * - Arabic from the invite's language: right to left.
 *
 * Local stack only: each test writes its own invited account and invite straight
 * into the local D1 (keyed inserts, a token only the test knows), reads the
 * sunk email from the local KV, and deletes everything in afterEach, pass or
 * fail. The "app" the invite continues to is the issuer's own GET
 * /session/accounts, which answers which accounts this browser holds.
 */
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { TEST_URLS } from '../../utils/test-data';

test.use({ trace: 'off' });

const AUTH_APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../apps/auth');
const AUTH = TEST_URLS.authServer;
const isLocal = /^http:\/\/localhost[:/]/.test(AUTH);
test.skip(!isLocal, 'writes invites straight into the local D1: local stack only');

const hex = (n: number) => randomBytes(n).toString('hex');
const sql = (s: string) => `'${s.replace(/'/g, "''")}'`;

function d1(command: string): string {
  // The running issuer holds the same local SQLite file: a write can meet SQLITE_BUSY, so retry a few times
  for (let attempt = 1; ; attempt++) {
    try {
      return execFileSync('npx', ['wrangler', 'd1', 'execute', 'AUTH_DB', '--local', '-c', 'wrangler.dev.json', '--json', '--command', command], {
        cwd: AUTH_APP,
        stdio: 'pipe',
      }).toString();
    } catch (err) {
      const busy = /SQLITE_BUSY|database is locked/.test(String((err as { stderr?: Buffer }).stderr ?? err));
      if (!busy || attempt >= 10) throw err;
      execFileSync('sleep', [String(Math.min(attempt, 4))]);
    }
  }
}

interface Seeded {
  email: string;
  userId: string;
  inviteId: string;
  link: string;
}

const created: Seeded[] = [];

/** An invited account and its invite, as POST /provisioning/invites makes them, with a link only this test knows. */
function seedInvite(opts: { locale?: 'en' | 'ar'; expired?: boolean; status?: 'invited' | 'active'; name?: string } = {}): Seeded {
  const userId = `usr_${hex(16)}`;
  const inviteId = `inv_${hex(16)}`;
  const email = `invite-${hex(5)}@e2e.alummahnow.net`;
  const token = hex(32);
  const hash = createHash('sha256').update(token).digest('hex');
  const now = Date.now();
  const expires = opts.expired ? now - 60_000 : now + 14 * 86_400_000;
  const continueUrl = `${AUTH}/session/accounts`;
  const metadata = JSON.stringify({ email_verified: false, invited: true, invited_at: now, invite_id: inviteId });
  d1(
    [
      `INSERT INTO users (id, tenant_id, email, name, metadata, status, created_at, updated_at, password_reset_required) VALUES (${sql(userId)}, 'default', ${sql(email)}, ${sql(opts.name ?? 'Invited Creator')}, ${sql(metadata)}, 'invited', ${now}, ${now}, 0)`,
      `INSERT OR IGNORE INTO rbac_user_roles (user_id, role_id, tenant_id, assigned_at, assigned_by) SELECT ${sql(userId)}, id, 'default', ${now}, 'user_system' FROM rbac_roles WHERE id = 'role_member' AND tenant_id = 'default'`,
      `INSERT INTO user_invites (id, tenant_id, user_id, email, name, locale, note, client_id, details, continue_url, token_hash, invited_by, invited_by_email, created_at, updated_at, expires_at, last_sent_at, send_count) VALUES (${sql(inviteId)}, 'default', ${sql(userId)}, ${sql(email)}, 'Invited Creator', ${sql(opts.locale ?? 'en')}, NULL, 'e2e-invites', '{}', ${sql(continueUrl)}, ${sql(hash)}, 'usr_e2e_admin', NULL, ${now}, ${now}, ${expires}, ${now - 3_600_000}, 1)`,
    ].join('; ')
  );
  const seeded = { email, userId, inviteId, link: `${AUTH}/invite/${token}${opts.locale === 'ar' ? '?lang=ar' : ''}` };
  created.push(seeded);
  return seeded;
}

/** Keyed deletes of the test's accounts and everything they made on the local D1 and KV. */
function cleanUp(s: Seeded): void {
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
    execFileSync('npx', ['wrangler', 'kv', 'key', 'delete', '--local', '-c', 'wrangler.dev.json', '--binding', 'AUTH_STORAGE', `test:invite:${s.email}`], { cwd: AUTH_APP, stdio: 'pipe' });
  } catch (error) {
    console.warn(`Could not delete ${s.email}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
  }
}

test.afterEach(() => {
  for (const s of created.splice(0)) cleanUp(s);
});

/** The link the local sink kept for an @e2e address (deliverInvite on a non-production stack). */
function sunkLink(email: string): string | null {
  try {
    const raw = execFileSync('npx', ['wrangler', 'kv', 'key', 'get', '--local', '-c', 'wrangler.dev.json', '--binding', 'AUTH_STORAGE', `test:invite:${email}`], { cwd: AUTH_APP, stdio: 'pipe' }).toString();
    return (JSON.parse(raw) as { link?: string }).link ?? null;
  } catch {
    return null;
  }
}

/** What GET /session/accounts says about this browser: the accounts and which one is active. */
async function browserAccounts(page: Page): Promise<{ active: string | null; users: string[] }> {
  const res = await page.request.get(`${AUTH}/session/accounts`);
  if (!res.ok()) return { active: null, users: [] };
  const body = (await res.json()) as { accounts?: Array<{ userId?: string; user_id?: string; isActive?: boolean; is_active?: boolean }> };
  const accounts = body.accounts ?? [];
  const id = (a: (typeof accounts)[number]) => a.userId ?? a.user_id ?? '';
  return { active: id(accounts.find((a) => a.isActive ?? a.is_active) ?? { userId: '' }) || null, users: accounts.map(id) };
}

async function addVirtualAuthenticator(context: BrowserContext, page: Page): Promise<void> {
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
}

/** Open the link, Continue, Skip the passkey: signed in, on the app. */
async function acceptAndSkip(page: Page, link: string): Promise<void> {
  await page.goto(link);
  await expect(page.locator('[data-page="invite"][data-state="ready"]')).toBeVisible();
  await page.locator('[data-action="accept-invite"]').click();
  await expect(page.locator('[data-page="passkey"]')).toBeVisible({ timeout: 15_000 });
  await page.locator('[data-page="passkey"] [data-action="skip"]').click();
  await page.waitForURL(`${AUTH}/session/accounts`, { timeout: 15_000 });
}

test.describe('Invite link', () => {
  test.setTimeout(90_000);

  test('fresh link: Continue signs in directly, offers a passkey with Skip, never a password', async ({ page }) => {
    const s = seedInvite();
    await page.goto(s.link);
    const ready = page.locator('[data-page="invite"][data-state="ready"]');
    await expect(ready).toContainText("Your account is ready");
    await expect(ready).toContainText(s.email);
    await expect(page.getByText(/create account/i)).toHaveCount(0);
    await page.locator('[data-action="accept-invite"]').click();
    const offer = page.locator('[data-page="passkey"]');
    await expect(offer).toBeVisible({ timeout: 15_000 });
    await expect(offer.locator('[data-action="skip"]')).toHaveText('Skip');
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
    await offer.locator('[data-action="skip"]').click();
    await page.waitForURL(`${AUTH}/session/accounts`, { timeout: 15_000 });
    expect((await browserAccounts(page)).active).toBe(s.userId);
  });

  test('fresh link: adding a passkey on the offer, then going on by itself', async ({ page, context, browserName }) => {
    test.skip(browserName !== 'chromium', 'virtual authenticator: Chromium only');
    const s = seedInvite();
    await addVirtualAuthenticator(context, page);
    await page.goto(s.link);
    await page.locator('[data-action="accept-invite"]').click();
    await page.locator('[data-page="passkey"] [data-action="add"]').click();
    await expect(page.locator('[data-page="passkey"] [data-slot="status"]')).toContainText('Passkey added', { timeout: 15_000 });
    await page.waitForURL(`${AUTH}/session/accounts`, { timeout: 15_000 });
    expect((await browserAccounts(page)).active).toBe(s.userId);
    // Set up now: in a browser that is not signed in, the used link says so and offers Sign in
    await context.clearCookies();
    await page.goto(s.link);
    const active = page.locator('[data-page="invite"][data-state="active"]');
    await expect(active).toContainText('You’re already set up');
    await expect(active.locator('[data-action="sign-in"]')).toHaveAttribute('href', `${AUTH}/session/accounts`);
  });

  test('other accounts signed in: no extra step, the invited account joins them as the active one', async ({ page }) => {
    const first = seedInvite();
    await acceptAndSkip(page, first.link);
    const invited = seedInvite();
    await page.goto(invited.link);
    // The same page as a signed-out browser gets: nothing about the other account
    await expect(page.locator('[data-page="invite"][data-state="ready"]')).toBeVisible();
    await expect(page.getByText(first.email)).toHaveCount(0);
    await page.locator('[data-action="accept-invite"]').click();
    await page.locator('[data-page="passkey"] [data-action="skip"]').click();
    await page.waitForURL(`${AUTH}/session/accounts`, { timeout: 15_000 });
    const now = await browserAccounts(page);
    expect(now.active).toBe(invited.userId);
    expect(now.users).toEqual(expect.arrayContaining([first.userId, invited.userId]));
  });

  test('second click, no password or passkey yet: "Finish setting up" emails a fresh link that signs in again', async ({ page, context }) => {
    const s = seedInvite();
    await acceptAndSkip(page, s.link);
    await context.clearCookies();
    await page.goto(s.link);
    const setup = page.locator('[data-page="invite"][data-state="setup"]');
    await expect(setup).toContainText('Finish setting up your account');
    await expect(page.getByText(/sign in/i)).toHaveCount(0);
    await setup.locator('[data-action="send-setup-link"]').click();
    await expect(page.locator('[data-page="invite"][data-state="sent"]')).toContainText('Check your inbox');
    const fresh = sunkLink(s.email);
    expect(fresh, 'the new link reached the (local) inbox').toBeTruthy();
    expect(await page.content()).not.toContain(fresh!.split('/invite/')[1]);
    await acceptAndSkip(page, fresh!);
    expect((await browserAccounts(page)).active).toBe(s.userId);
  });

  test('expired link that was never used: "Finish setting up"', async ({ page }) => {
    const s = seedInvite({ expired: true });
    await page.goto(s.link);
    await expect(page.locator('[data-page="invite"][data-state="setup"]')).toBeVisible();
  });

  test('revoked: withdrawn; unknown: doesn\'t work; neither says sign in', async ({ page }) => {
    const s = seedInvite();
    d1(`UPDATE user_invites SET deleted_at = ${Date.now()}, token_used_at = ${Date.now()} WHERE id = ${sql(s.inviteId)}`);
    await page.goto(s.link);
    await expect(page.locator('[data-page="invite"][data-state="withdrawn"]')).toContainText('This invite was withdrawn');
    await expect(page.getByText(/sign in/i)).toHaveCount(0);
    await page.goto(`${AUTH}/invite/${hex(32)}`);
    await expect(page.locator('[data-page="invite"][data-state="unknown"]')).toContainText('This link doesn’t work');
    await expect(page.getByText(/sign in/i)).toHaveCount(0);
  });

  test('Arabic from the invite\'s language, right to left', async ({ page }) => {
    const s = seedInvite({ locale: 'ar' });
    await page.goto(s.link.replace('?lang=ar', ''));
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('[data-page="invite"][data-state="ready"]')).toContainText('حسابك جاهز');
    await page.locator('[data-action="accept-invite"]').click();
    await expect(page.locator('[data-page="passkey"] [data-action="skip"]')).toHaveText('تجاوز');
  });
});

