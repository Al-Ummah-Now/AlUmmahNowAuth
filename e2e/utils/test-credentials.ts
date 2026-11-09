/**
 * Passwords typed by the E2E suite (every test user is a fresh throwaway account).
 *
 * One source so CI can hand these values to scripts/ci/scan-artifacts-for-secrets.py,
 * which removes and fails any test artifact that still contains them. Type them only
 * with fillSecret() (e2e/utils/secret-input.ts), never locator.fill().
 */
export const TEST_PASSWORD = 'TestPassword123!';
export const NEW_TEST_PASSWORD = 'NewTestPassword456!';
