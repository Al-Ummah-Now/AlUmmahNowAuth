/**
 * E2E: the staff "Your role needs a passkey" card (AUTH-PASSKEYS PK3), with a
 * Chromium virtual authenticator on the local stack.
 *
 * Owner report 2026-11-14 (Fawanees dark): "Email me a code" and "Continue"
 * were dark on dark, and the page never said the passkey prompt (where
 * 1Password offers to save it) only comes after the emailed code. The card is
 * now three steps (1 email me a code, 2 enter the code, 3 add the passkey) with
 * a filled accent button per step, and a skip button that says what it does.
 *
 * - The full staff flow: code, then the passkey prompt opens by itself, with
 *   the standard WebAuthn options a password manager can intercept (resident
 *   key and user verification required), and the passkey lands in the hub.
 * - en and ar: a wrong code, and a browser that doesn't let the page open the
 *   prompt by itself: "Add a passkey" is the step's button.
 * - axe (WCAG 2.2 AA) on every step in every built-in theme, Light and Dark, en and ar.
 *
 * Staff: the spec gives its own account the Moderator role on the local D1 and
 * switches staff enforcement on with a start one hour ahead (so no other spec's
 * staff account is refused), restoring the setting afterwards.
 *
 * PASSKEY_SHOTS_DIR=<dir> also saves dark screenshots of each step (desktop and
 * phone, en and ar) for the owner's review.
 */
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { setupEmailInterception } from '../../utils/email-interceptor';
import { addVirtualAuthenticator, deleteLocalAccount, isLocalStack, localSql, signUpToCard } from '../../utils/passkey-local';
import { fillSecret } from '../../utils/secret-input';
import { TEST_PASSWORD } from '../../utils/test-credentials';
import { TEST_URLS, generateTestEmail } from '../../utils/test-data';

test.use({ trace: 'off' });
test.skip(({ browserName }) => browserName !== 'chromium' || !isLocalStack, 'virtual authenticator: Chromium on the local stack only');
test.describe.configure({ mode: 'serial' });

const THEMES = ['fawanees', 'lantern', 'classic', 'nahas', 'zujaj'] as const;
const SHOTS = process.env.PASSKEY_SHOTS_DIR;
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };
// The policy setting is cached 30 s per isolate (apps/auth/src/passkeys/policy.ts)
const POLICY_CACHE_MS = 31_000;

const card = (page: Page) => page.locator('[data-page="passkey"]');
const stepItem = (page: Page, n: number) => card(page).locator(`[data-step="${n}"]`);

let previousSetting: string | null = null;
let settingWrittenAt = 0;
const accounts: string[] = [];

test.beforeAll(() => {
  const rows = JSON.parse(localSql(`SELECT value FROM auth_settings WHERE key = 'staff_passkeys'`)) as { results: { value: string }[] }[];
  previousSetting = rows[0]?.results[0]?.value ?? null;
  const value = JSON.stringify({ enforced: true, enforcedAt: Date.now() + 60 * 60 * 1000, graceDays: 7 }).replace(/'/g, "''");
  localSql(
    `INSERT INTO auth_settings (key, value, updated_at, updated_by) VALUES ('staff_passkeys', '${value}', ${Date.now()}, 'e2e') ` +
      `ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
  );
  settingWrittenAt = Date.now();
});

test.afterAll(() => {
  if (previousSetting === null) localSql(`DELETE FROM auth_settings WHERE key = 'staff_passkeys'`);
  else localSql(`UPDATE auth_settings SET value = '${previousSetting.replace(/'/g, "''")}' WHERE key = 'staff_passkeys'`);
});

test.afterEach(() => {
  for (const email of accounts.splice(0)) deleteLocalAccount(email);
});

/**
 * Every sign-in page of the flow in `theme.id` (per-call ?theme=, which the
 * flow carries on); change `id` to switch. The theme goes on Profile's redirect
 * to /authorize (a navigation's URL can't be rewritten in flight).
 */
async function useTheme(context: BrowserContext, id: string): Promise<{ id: string }> {
  const theme = { id };
  await context.route(`${TEST_URLS.profileApp}/**`, async (route) => {
    if (!route.request().isNavigationRequest()) return route.continue();
    const response = await route.fetch({ maxRedirects: 0 });
    const location = response.headers()['location'];
    if (!location || !location.includes('/authorize')) return route.fulfill({ response });
    const url = new URL(location, TEST_URLS.profileApp);
    url.searchParams.set('theme', theme.id);
    return route.fulfill({ response, headers: { ...response.headers(), location: url.toString() } });
  });
  return theme;
}

/** A password sign-in from a fresh browser (no Profile or Auth session), up to the staff card. */
async function signInToCard(page: Page, context: BrowserContext, email: string, lang: 'en' | 'ar'): Promise<void> {
  await context.clearCookies();
  // Profile's /login (its redirect to /authorize is the first response, so useTheme can add ?theme)
  await page.goto(`${TEST_URLS.profileApp}/login?return=${encodeURIComponent(lang === 'ar' ? '/?lang=ar' : '/')}`);
  await expect(page.locator('input[type="email"]')).toBeVisible({ timeout: 15000 });
  await page.fill('input[type="email"]', email);
  await fillSecret(page.locator('input[type="password"]').first(), TEST_PASSWORD);
  const wait = settingWrittenAt + POLICY_CACHE_MS - Date.now();
  if (wait > 0) await page.waitForTimeout(wait);
  await page.getByRole('button', { name: lang === 'ar' ? 'متابعة' : 'Continue', exact: true }).click();
  await expect(card(page)).toBeVisible({ timeout: 20000 });
}

/**
 * A member account made staff: sign up (member card: Not now), give it the
 * Moderator role, then a fresh password sign-in: the staff card.
 */
async function signInAsNewStaff(page: Page, context: BrowserContext, label: string, lang: 'en' | 'ar' = 'en'): Promise<string> {
  const email = generateTestEmail(`pk-${label}`);
  accounts.push(email);
  await context.clearCookies();
  await signUpToCard(page, email);
  await card(page).locator('[data-action="skip"]').click();
  await expect(page.locator('#loggedInView')).toBeVisible({ timeout: 20000 });

  const e = email.replace(/'/g, "''");
  localSql(
    `INSERT INTO rbac_user_roles (user_id, role_id, tenant_id, assigned_at, assigned_by) ` +
      `SELECT id, 'role_moderator', 'default', ${Date.now()}, 'e2e' FROM users WHERE email = '${e}'`
  );
  await signInToCard(page, context, email, lang);
  return email;
}

async function expectCurrentStep(page: Page, n: number): Promise<void> {
  for (const k of [1, 2, 3]) {
    await expect(stepItem(page, k)).toHaveAttribute('data-state', k < n ? 'done' : k === n ? 'current' : 'todo');
  }
  await expect(stepItem(page, n)).toHaveAttribute('aria-current', 'step');
}

/** A filled button: its background is not transparent and differs from the card behind it. */
async function expectFilled(page: Page, selector: string): Promise<void> {
  const { bg, image } = await card(page)
    .locator(selector)
    .evaluate((el) => {
      const s = getComputedStyle(el);
      return { bg: s.backgroundColor, image: s.backgroundImage };
    });
  expect(image !== 'none' || !/rgba\(0, 0, 0, 0\)|transparent/.test(bg), `${selector} background ${bg} ${image}`).toBe(true);
}

/** The secondary button: no fill, but a visible border. */
async function expectOutlined(page: Page, selector: string): Promise<void> {
  const s = await card(page)
    .locator(selector)
    .evaluate((el) => {
      const c = getComputedStyle(el);
      return { bg: c.backgroundColor, width: c.borderTopWidth, color: c.borderTopColor };
    });
  expect(s.bg).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
  expect(parseFloat(s.width)).toBeGreaterThanOrEqual(1);
  expect(s.color).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
}

async function axe(page: Page, where: string): Promise<string[]> {
  const result = await new AxeBuilder({ page }).include('[data-page="passkey"]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  return result.violations.map((v) => `${where}: ${v.id} ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
}

/**
 * Contrast of the current step's number on its accent fill (axe leaves it
 * "incomplete": the rail is a pseudo element). Colours go through a canvas, so
 * oklch() and color-mix() values resolve to sRGB.
 */
async function currentMarkContrast(page: Page): Promise<number> {
  return card(page)
    .locator('[data-step][data-state="current"] [data-slot="mark"]')
    .evaluate((el) => {
      const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
      const rgb = (css: string) => {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = css;
        ctx.fillRect(0, 0, 1, 1);
        return [...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)];
      };
      const lum = ([r, g, b]: number[]) =>
        [r, g, b].map((v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((a, v, k) => a + v * [0.2126, 0.7152, 0.0722][k], 0);
      const s = getComputedStyle(el);
      const [a, b] = [lum(rgb(s.color)), lum(rgb(s.backgroundColor))];
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    });
}

/** Desktop and phone dark screenshots of the card as it is now. */
async function shoot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  // The sign-in root is absolutely positioned (fullPage can't see past it): grow the viewport instead
  for (const [label, size] of [['desktop', DESKTOP], ['phone', PHONE]] as const) {
    await page.setViewportSize(size);
    for (let i = 0; i < 6; i++) {
      const { need, have } = await page.evaluate(() => {
        const els = [document.documentElement, document.body, ...document.querySelectorAll<HTMLElement>('[data-component="root"], [data-component="center"]')];
        const bottom = Math.max(...[...document.querySelectorAll('[data-component="center"], [data-page="passkey"]')].map((el) => el.getBoundingClientRect().bottom + 32));
        return { need: Math.ceil(Math.max(bottom, ...els.map((el) => el.scrollHeight))), have: window.innerHeight };
      });
      if (need <= have) break;
      await page.setViewportSize({ width: size.width, height: need });
    }
    await page.screenshot({ path: path.join(SHOTS, `${name}-${label}.png`) });
  }
  await page.setViewportSize(DESKTOP);
}

/** The browser's "may this page open the passkey prompt now" answer, forced to No. */
async function blockPromptWithoutClick(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'userActivation', { configurable: true, value: { isActive: false, hasBeenActive: true } });
  });
}

test.describe('Staff passkey card', () => {
  test.setTimeout(180000);

  test('code, then the passkey prompt opens by itself with password-manager options (en, Fawanees dark)', async ({ page, context }) => {
    await page.setViewportSize(DESKTOP);
    await page.emulateMedia({ colorScheme: 'dark' });
    await useTheme(context, 'fawanees');
    const { cdp, authenticatorId } = await addVirtualAuthenticator(context, page);
    const email = await signInAsNewStaff(page, context, 'staff-en');

    // Step 1: one filled button, the skip says what it does (with the grace date)
    await expect(card(page).locator('[data-component="title"]')).toHaveText('Your role needs a passkey');
    await expectCurrentStep(page, 1);
    await expectFilled(page, '[data-action="send-code"]');
    const skip = card(page).locator('[data-action="skip"]');
    await expect(skip).toHaveText(/^Not now, use my password until \d{1,2} \w+ \d{4}$/);
    await expectOutlined(page, '[data-action="skip"]');
    await expect(card(page).locator('[data-action="add"]')).toBeHidden();
    expect(await axe(page, 'step 1')).toEqual([]);
    // Step 2: the code from the email
    const inbox = setupEmailInterception();
    await card(page).locator('[data-action="send-code"]').click();
    await expectCurrentStep(page, 2);
    await expect(card(page).locator('input[name="code"]')).toBeFocused();
    await expectFilled(page, '[data-action="confirm-code"]');
    expect(await axe(page, 'step 2')).toEqual([]);
    const code = await inbox.getLastLoginCode(email);
    if (!code) throw new Error('No passkey code in the local sink');
    await fillSecret(card(page).locator('input[name="code"]'), code);

    // Step 3 starts the ceremony at once: standard navigator.credentials.create options
    const optionsResponse = page.waitForResponse((r) => r.url().includes('/passkeys/register/options'));
    await card(page).locator('[data-action="confirm-code"]').click();
    const { options } = (await (await optionsResponse).json()) as { options: Record<string, any> };
    expect(options.rp.id).toBe('localhost');
    expect(options.user.name).toBe(email);
    expect(options.authenticatorSelection).toMatchObject({ residentKey: 'required', requireResidentKey: true, userVerification: 'required' });
    expect(options.attestation).toBe('none');
    expect(options.pubKeyCredParams.map((p: { alg: number }) => p.alg)).toEqual(expect.arrayContaining([-7, -257]));

    const done = card(page).locator('[data-action="done"]');
    await expect(done).toBeVisible({ timeout: 15000 });
    await expect(done).toBeFocused();
    await expect(card(page).locator('[data-slot="status"]')).toBeVisible();
    await expect(card(page).locator('[data-slot="status"]')).toHaveText('Passkey added. Next time, choose "Sign in with a passkey".');
    await expect(skip).toBeHidden();
    for (const k of [1, 2, 3]) await expect(stepItem(page, k)).toHaveAttribute('data-state', 'done');
    expect(await axe(page, 'done')).toEqual([]);

    // A discoverable credential with user verification, for this RP
    const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
    expect(credentials).toHaveLength(1);
    expect(credentials[0]).toMatchObject({ isResidentCredential: true, rpId: 'localhost' });

    await done.click();
    await expect(page.locator('#loggedInView')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('#passkeyList [data-passkey-id]')).toHaveCount(1, { timeout: 15000 });
  });

  const FALLBACK = {
    en: {
      title: 'Your role needs a passkey',
      skip: 'Not now, use my password until',
      wrong: 'That code is not right. Check the email and try again.',
      pressAdd: 'Code accepted. Select "Add a passkey" to save it.',
    },
    ar: {
      title: 'يحتاج دورك إلى مفتاح مرور',
      skip: 'ليس الآن، سأستخدم كلمة المرور حتى',
      wrong: 'الرمز غير صحيح. تحقق من الرسالة وحاول مرة أخرى.',
      pressAdd: 'قُبل الرمز. اختر «إضافة مفتاح مرور» لحفظه.',
    },
  } as const;

  for (const lang of ['en', 'ar'] as const) {
    test(`${lang}: a wrong code, then "Add a passkey" when the browser waits for a click`, async ({ page, context }) => {
      const t = FALLBACK[lang];
      await page.setViewportSize(DESKTOP);
      await page.emulateMedia({ colorScheme: 'dark' });
      await useTheme(context, 'fawanees');
      const { cdp, authenticatorId } = await addVirtualAuthenticator(context, page);
      const email = await signInAsNewStaff(page, context, `staff-fb-${lang}`, lang);

      await expect(page.locator('html')).toHaveAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr');
      await expect(card(page).locator('[data-component="title"]')).toHaveText(t.title);
      await expect(card(page).locator('[data-action="skip"]')).toContainText(t.skip);
      await expectCurrentStep(page, 1);
      await shoot(page, `${lang}-1-email-code`);

      const inbox = setupEmailInterception();
      await card(page).locator('[data-action="send-code"]').click();
      await expectCurrentStep(page, 2);
      const code = await inbox.getLastLoginCode(email);
      if (!code) throw new Error('No passkey code in the local sink');

      // Wrong code: stays on step 2, the message right under the step's button
      const wrong = code === '000000' ? '111111' : '000000';
      await fillSecret(card(page).locator('input[name="code"]'), wrong);
      await card(page).locator('[data-action="confirm-code"]').click();
      const error = stepItem(page, 2).locator('[data-slot="status"][data-tone="error"]');
      await expect(error).toBeVisible();
      await expect(error).toHaveText(t.wrong);
      await expectCurrentStep(page, 2);
      expect(await axe(page, `${lang} step 2 error`)).toEqual([]);
      await shoot(page, `${lang}-2-enter-code`);

      // The right code, on a browser that won't open the prompt without a fresh click
      await blockPromptWithoutClick(page);
      await fillSecret(card(page).locator('input[name="code"]'), code);
      await card(page).locator('[data-action="confirm-code"]').click();
      await expectCurrentStep(page, 3);
      const add = card(page).locator('[data-action="add"]');
      await expect(add).toBeVisible();
      await expect(add).toBeFocused();
      await expectFilled(page, '[data-action="add"]');
      await expect(stepItem(page, 3).locator('[data-slot="status"]')).toBeVisible();
      await expect(stepItem(page, 3).locator('[data-slot="status"]')).toHaveText(t.pressAdd);
      expect((await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials).toHaveLength(0);
      expect(await axe(page, `${lang} step 3`)).toEqual([]);
      await shoot(page, `${lang}-3-add-passkey`);

      await add.click();
      await expect(card(page).locator('[data-action="done"]')).toBeVisible({ timeout: 15000 });
      expect((await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials).toHaveLength(1);
      await shoot(page, `${lang}-4-done`);
    });
  }

  test('every step passes axe in every theme, Light and Dark, en and ar', async ({ page, context }) => {
    test.setTimeout(360000);
    await page.setViewportSize(DESKTOP);
    const theme = await useTheme(context, THEMES[0]);
    // One staff account per language keeps each under the per-email sign-in limit (10 a minute)
    const emails = { en: await signInAsNewStaff(page, context, 'staff-axe-en'), ar: await signInAsNewStaff(page, context, 'staff-axe-ar', 'ar') };
    const problems: string[] = [];
    for (const id of THEMES) {
      theme.id = id;
      for (const lang of ['en', 'ar'] as const) {
        // The real card: a staff sign-in in this theme and language
        await signInToCard(page, context, emails[lang], lang);
        await expect(page.locator('html')).toHaveAttribute('data-theme', id);
        await expect(page.locator('html')).toHaveAttribute('lang', lang);
        for (const mode of ['light', 'dark'] as const) {
          await page.emulateMedia({ colorScheme: mode });
          for (const n of [1, 2, 3, 4]) {
            // Each step's look, through the same DOM state the page script sets
            await page.evaluate((current) => {
              const root = document.querySelector('[data-page="passkey"]')!;
              root.querySelectorAll<HTMLElement>('li[data-step]').forEach((li) => {
                const k = Number(li.dataset.step);
                li.dataset.state = k < current ? 'done' : k === current ? 'current' : 'todo';
              });
              const status = root.querySelector<HTMLElement>('[data-slot="status"]')!;
              const body = root.querySelector(`li[data-step="${current}"] [data-slot="step-body"]`);
              if (body) body.insertBefore(status, body.querySelector('[data-variant="link"]'));
              else root.insertBefore(status, root.querySelector('[data-action="done"]'));
              status.textContent = current === 2 ? 'That code is not right. Check the email and try again.' : current === 4 ? 'Passkey added.' : '';
              if (current === 2) status.dataset.tone = 'error';
              else delete status.dataset.tone;
              root.querySelector<HTMLElement>('[data-action="done"]')!.hidden = current !== 4;
              root.querySelector<HTMLElement>('[data-action="skip"]')!.hidden = current === 4;
            }, n);
            const where = `${id} ${lang} ${mode} step ${n}`;
            problems.push(...(await axe(page, where)));
            if (n < 4) {
              const ratio = await currentMarkContrast(page);
              if (ratio < 4.5) problems.push(`${where}: step number contrast ${ratio.toFixed(2)}`);
            }
          }
          await page.evaluate(() => {
            document.querySelector<HTMLElement>('[data-page="passkey"] [data-action="skip"]')!.hidden = false;
          });
          await expectOutlined(page, '[data-action="skip"]');
          await expectFilled(page, '[data-action="send-code"]');
        }
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });
});
