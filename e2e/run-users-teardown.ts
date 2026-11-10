/**
 * Playwright global teardown: delete the per-run accounts this invocation generated
 * (e2e/utils/run-accounts.ts) via the auth server's
 * POST /test/run-users/delete/:email (apps/auth/src/routes/test-run-users.ts).
 *
 * Needs E2E_CODE_SINK_SECRET and TEST_PROMOTE_SECRET for the target environment.
 * Without them it logs and leaves the accounts to the 24 h sweeper. Addresses that
 * were generated but never signed up come back as found: 0. Never fails the run
 * and never prints a secret.
 */
import { clearRunAccounts, readRunAccounts } from './utils/run-accounts';

const AUTH_SERVER_URL = process.env.E2E_AUTH_SERVER_URL || 'http://localhost:3301';

export default async function globalTeardown(): Promise<void> {
  if (!process.env.GITHUB_RUN_ID) return;
  const emails = readRunAccounts();
  if (emails.length === 0) return;
  const sinkSecret = process.env.E2E_CODE_SINK_SECRET;
  const promoteSecret = process.env.TEST_PROMOTE_SECRET;
  if (!sinkSecret || !promoteSecret) {
    console.log(`Run teardown skipped: E2E_CODE_SINK_SECRET or TEST_PROMOTE_SECRET is not set; the sweeper deletes the ${emails.length} run account(s) after 24 h`);
    return;
  }

  let deleted = 0;
  const failures: string[] = [];
  for (const email of emails) {
    try {
      const res = await fetch(`${AUTH_SERVER_URL}/test/run-users/delete/${encodeURIComponent(email)}`, {
        method: 'POST',
        headers: { 'X-E2E-Secret': sinkSecret, 'X-Test-Secret': promoteSecret },
      });
      if (res.ok) {
        const body = (await res.json().catch(() => ({}))) as { found?: number };
        deleted += body.found ?? 0;
      } else {
        failures.push(`${email}: ${res.status}`);
      }
    } catch (error) {
      failures.push(`${email}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log(`Run teardown: deleted ${deleted} run account(s) of ${emails.length} generated address(es)`);
  if (failures.length > 0) console.warn(`Run teardown could not delete (the sweeper retries after 24 h):\n  ${failures.join('\n  ')}`);
  clearRunAccounts();
}
