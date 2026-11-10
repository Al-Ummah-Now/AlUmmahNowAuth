/**
 * Passwords typed by the E2E suite (every test user is a fresh throwaway account).
 *
 * They come from the CI secrets E2E_TEST_PASSWORD and E2E_NEW_TEST_PASSWORD, never
 * from the repo: this repo is public and the suite runs against the shared QA and
 * stage auth servers. CI hands the same variables to scripts/ci/scan-e2e-output.sh,
 * which removes and fails any test artifact that still contains them. Type them only
 * with fillSecret() (e2e/utils/secret-input.ts), never locator.fill().
 *
 * Locally, unset variables get a random value per Playwright worker process. That is
 * enough because a test only signs in to accounts it registered itself.
 */
import { randomBytes } from 'node:crypto';

function credential(name: string): string {
  const value = process.env[name];
  if (value) return value;
  if (process.env.CI) throw new Error(`${name} is not set: pass the ${name} secret to this E2E step`);
  // Upper, lower, digit and symbol, so it meets any password policy
  return `Aa1!${randomBytes(12).toString('base64url')}`;
}

export const TEST_PASSWORD = credential('E2E_TEST_PASSWORD');
export const NEW_TEST_PASSWORD = credential('E2E_NEW_TEST_PASSWORD');
