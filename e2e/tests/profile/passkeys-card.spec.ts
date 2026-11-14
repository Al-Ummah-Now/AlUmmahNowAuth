/**
 * The account hub's Passkeys card on a fresh sign-up (any environment, no authenticator needed):
 * - the list loads: no "Something went wrong. Try again." or any other error state;
 * - the signed-in page's cards keep one vertical rhythm (they never touch).
 *
 * Owner report 2026-11-13 (production): the card showed the error on load, and the profile
 * card and the Passkeys card nearly touched.
 */
import { test, expect, type Page } from '@playwright/test';
import { register } from '../../fixtures/auth';
import { TEST_URLS, generateTestEmail } from '../../utils/test-data';

// Signs up with the test password and an email code: no traces (e2e/utils/secret-input.ts)
test.use({ trace: 'off' });

async function expectHealthyCard(page: Page): Promise<void> {
  const card = page.locator('#passkeys');
  await expect(card).toBeVisible({ timeout: 15000 });
  // Loaded: the empty text (a new account has no passkeys) and the Add button
  await expect(card.locator('#passkeysEmpty')).toBeVisible({ timeout: 15000 });
  await expect(card.locator('#passkeyAdd')).toBeVisible();
  // No error state anywhere in the card
  await expect(card.locator('[data-tone="error"]')).toHaveCount(0);
  await expect(card.locator('#passkeyStatus')).toHaveText('');
}

/** Vertical gap (px) between each visible block of the signed-in page and the next. */
async function gapsBetweenBlocks(page: Page): Promise<number[]> {
  return page.locator('#loggedInView').evaluate((root) => {
    const blocks = [...root.children].filter((el) => (el as HTMLElement).offsetParent !== null);
    const gaps: number[] = [];
    for (let i = 1; i < blocks.length; i++) {
      gaps.push(Math.round(blocks[i].getBoundingClientRect().top - blocks[i - 1].getBoundingClientRect().bottom));
    }
    return gaps;
  });
}

test.describe('Account hub: Passkeys card', () => {
  test.setTimeout(120000);

  test('loads without an error, and the cards are evenly spaced (en, then ar)', async ({ page }) => {
    await register(page, generateTestEmail('hub-card-health'));
    await expectHealthyCard(page);

    const gaps = await gapsBetweenBlocks(page);
    expect(gaps.length).toBeGreaterThanOrEqual(2);
    for (const gap of gaps) expect(gap, `gaps between blocks: ${gaps.join(', ')} px`).toBeGreaterThanOrEqual(24);
    expect(Math.max(...gaps) - Math.min(...gaps), `gaps between blocks: ${gaps.join(', ')} px`).toBeLessThanOrEqual(1);

    // Arabic page: same card, Arabic copy, still no error
    await page.goto(`${TEST_URLS.profileApp}/?lang=ar`);
    await expectHealthyCard(page);
    await expect(page.locator('#passkeys')).toContainText('مفتاح مرور');
  });
});
