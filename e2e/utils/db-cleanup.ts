/**
 * Database Cleanup Utilities
 *
 * Functions to clean up test data from D1 database and KV storage.
 */

import { execSync } from 'child_process';
import { join } from 'path';

// Path to auth app root (relative to e2e directory)
const AUTH_APP_PATH = join(__dirname, '../../apps/auth');

/**
 * Clean up test users from D1 database
 *
 * Removes all users with email addresses containing '@e2e-test.local'
 * This is safe since real users will never have this domain.
 */
export async function cleanupTestUsers(): Promise<void> {
  console.log('Cleaning up test users from D1 database...');

  try {
    // Delete all users with e2e test emails
    execSync(
      `npx wrangler d1 execute AUTH_DB --local --persist-to=../../.wrangler/state --command "DELETE FROM user WHERE email LIKE '%@e2e-test.local'"`,
      {
        cwd: AUTH_APP_PATH,
        stdio: 'pipe' // Suppress output unless there's an error
      }
    );
    console.log('✓ Test users cleaned up');
  } catch (error) {
    console.warn('Warning: Failed to cleanup test users:', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Clean up test sessions from KV storage
 *
 * Note: KV cleanup is complex because we need to list all keys first.
 * For now, sessions will naturally expire, and unique emails prevent conflicts.
 */
export async function cleanupTestSessions(): Promise<void> {
  console.log('Cleaning up test sessions from KV storage...');

  try {
    // KV cleanup via wrangler is not straightforward for local testing
    // Sessions are scoped by email, and we use unique emails per test,
    // so old sessions won't interfere. They'll expire naturally.
    console.log('✓ Test sessions will expire naturally (no action needed)');
  } catch (error) {
    console.warn('Warning: Failed to cleanup test sessions:', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Clean up rate limit entries for test IPs
 *
 * Rate limits are stored in KV with TTL, so they expire automatically.
 * For tests, we can increase limits or use unique identifiers.
 */
export async function cleanupRateLimits(): Promise<void> {
  console.log('Cleaning up rate limit entries...');

  try {
    // Rate limits have TTL and will expire automatically
    // For parallel tests, unique emails prevent conflicts
    console.log('✓ Rate limits will expire naturally (TTL-based)');
  } catch (error) {
    console.warn('Warning: Failed to cleanup rate limits:', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Full cleanup function to run before test suites
 *
 * Should be called in globalSetup or beforeAll hooks
 */
export async function fullCleanup(): Promise<void> {
  console.log('\n🧹 Starting E2E test cleanup...\n');
  await cleanupTestUsers();
  await cleanupTestSessions();
  await cleanupRateLimits();
  console.log('\n✅ E2E test cleanup completed\n');
}
