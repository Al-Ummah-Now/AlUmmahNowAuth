/**
 * Registry of the per-run accounts (e2e+<run>-<attempt>-<name>@e2e.alummahnow.net)
 * this Playwright invocation generated, for the run teardown (e2e/run-users-teardown.ts).
 *
 * Every worker appends to one file; the global setup empties it and the global
 * teardown deletes each address through POST /test/run-users/delete/:email.
 * Addresses are not secrets. Only used when GITHUB_RUN_ID is set (CI).
 */
import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const RUN_ACCOUNTS_FILE = process.env.E2E_RUN_ACCOUNTS_FILE || path.resolve(__dirname, '../../.e2e-run-accounts.txt');

export function recordRunAccount(email: string): void {
  try {
    appendFileSync(RUN_ACCOUNTS_FILE, `${email}\n`);
  } catch (error) {
    // Never fail a test over bookkeeping: the 24 h sweeper still deletes the account
    console.warn(`Could not record run account for teardown: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function readRunAccounts(): string[] {
  if (!existsSync(RUN_ACCOUNTS_FILE)) return [];
  return [...new Set(readFileSync(RUN_ACCOUNTS_FILE, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean))];
}

export function clearRunAccounts(): void {
  rmSync(RUN_ACCOUNTS_FILE, { force: true });
}
