/**
 * E2E Test: features that need an emailed code are hidden without the email key
 *
 * Owner rule: if config blocks a feature, that feature is hidden. This spec
 * starts its own local Auth worker (apps/auth, `wrangler dev`, the local D1
 * of `pnpm migrations:local`) twice on a free port: first with
 * RESEND_API_KEY blanked (`--var`), then with the key from .dev.vars.
 *
 * - key off: the sign-in page has no "Register" or "Forgot password?",
 *   /password/register and /password/change answer 404;
 * - key on: both links are there and lead to their forms.
 *
 * No email is sent in either state (nothing is submitted), so no email
 * provider is involved. Local stack only: it skips against QA/stage/prod.
 */

import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEST_URLS } from '../../utils/test-data';

const AUTH_APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../apps/auth');
const isLocal = /^http:\/\/localhost[:/]/.test(TEST_URLS.authServer);
const PORT = Number(process.env.E2E_AUTH_TOGGLE_PORT || 3341);
const BASE = `http://localhost:${PORT}`;
// The local Profile client (migrations/0004_seed_data.sql); public, so PKCE S256
const PROFILE_CLIENT = '109a1087-6626-40f7-8a7f-7f42f83f4f30';
const PROFILE_REDIRECT = 'http://localhost:3302/callback';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

test.skip(!isLocal, 'starts its own local Auth worker: local stack only');
test.describe.configure({ mode: 'serial' });
test.setTimeout(60_000);

let worker: ChildProcess | null = null;

async function startAuth(emailKey: boolean) {
  const args = ['wrangler', 'dev', '-c', 'wrangler.dev.json', '--port', String(PORT), '--inspector-port', String(PORT + 10)];
  // A blank key: Auth can't send email (utils/email-availability.ts)
  if (!emailKey) args.push('--var', 'RESEND_API_KEY: ');
  worker = spawn('npx', args, { cwd: AUTH_APP, stdio: 'ignore', detached: true });
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Auth worker did not start on ${BASE}`);
}

async function stopAuth() {
  if (!worker?.pid) return;
  try {
    process.kill(-worker.pid, 'SIGTERM'); // the whole group: npx, wrangler, workerd
  } catch {
    // already gone
  }
  worker = null;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      await fetch(`${BASE}/health`);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** /authorize → the sign-in page; returns its flow query (auth_flow). */
async function openSignIn(page: Page, lang: 'en' | 'ar' = 'en') {
  const authorize = new URL('/authorize', BASE);
  authorize.search = new URLSearchParams({
    client_id: PROFILE_CLIENT,
    response_type: 'code',
    state: 'e2e',
    redirect_uri: PROFILE_REDIRECT,
    provider: 'password',
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    ...(lang === 'ar' ? { lang: 'ar' } : {}),
  }).toString();
  await page.goto(authorize.toString());
  await expect(page).toHaveURL(/\/password\/authorize/);
  await expect(page.locator('input[name="password"]')).toBeVisible();
  return new URL(page.url()).search;
}

test.describe('email key missing', () => {
  test.beforeAll(async () => {
    test.setTimeout(120_000);
    await startAuth(false);
  });
  test.afterAll(stopAuth);

  for (const lang of ['en', 'ar'] as const) {
    test(`sign-in page (${lang}): no Register or Forgot password`, async ({ page }) => {
      await openSignIn(page, lang);
      const form = page.locator('form[data-component="form"]').first();
      await expect(form.locator('[data-component="form-footer"]')).toHaveCount(0);
      await expect(page.locator('a[href^="register"], a[href^="change"]')).toHaveCount(0);
      await expect(page.getByText(lang === 'ar' ? 'نسيت كلمة المرور؟' : 'Forgot password?')).toHaveCount(0);
      // Sign-in itself and passkeys stay
      await expect(page.locator('input[type="email"]')).toBeVisible();
    });
  }

  test('register and forgot password answer 404', async ({ page }) => {
    const query = await openSignIn(page);
    for (const route of ['/password/register', '/password/change']) {
      const res = await page.goto(`${BASE}${route}${query}`);
      expect(res?.status(), route).toBe(404);
      await expect(page.locator('body')).not.toContainText(/configured|couldn't send/i);
    }
  });
});

test.describe('email key present', () => {
  test.beforeAll(async () => {
    test.setTimeout(120_000);
    await startAuth(true);
  });
  test.afterAll(stopAuth);

  for (const lang of ['en', 'ar'] as const) {
    test(`sign-in page (${lang}): Register and Forgot password are shown`, async ({ page }) => {
      await openSignIn(page, lang);
      await expect(page.locator('a[href^="register"]')).toBeVisible();
      await expect(page.getByText(lang === 'ar' ? 'نسيت كلمة المرور؟' : 'Forgot password?')).toBeVisible();
    });
  }

  test('the links open the register and forgot password forms', async ({ page }) => {
    await openSignIn(page);
    await page.locator('a[href^="register"]').click();
    await expect(page).toHaveURL(/\/password\/register/);
    await expect(page.locator('input[name="repeat"]')).toBeVisible();

    await openSignIn(page);
    await page.locator('a[href^="change"]').click();
    await expect(page).toHaveURL(/\/password\/change/);
    await expect(page.locator('input[type="email"]')).toBeVisible();
  });
});
