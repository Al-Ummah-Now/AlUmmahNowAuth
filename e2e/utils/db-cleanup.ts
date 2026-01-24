/**
 * Database Cleanup Utilities
 *
 * Functions to clean up test data from D1 database and KV storage.
 * Supports both local (wrangler dev) and remote (QA/CI) environments.
 */

import { execSync } from 'child_process';
import { join } from 'path';

// Path to auth app root (relative to e2e directory)
const AUTH_APP_PATH = join(__dirname, '../../apps/auth');

// Detect CI/QA environment - when E2E_AUTH_SERVER_URL is set, we're running against remote
const isRemoteEnvironment = !!process.env.E2E_AUTH_SERVER_URL;

/**
 * Execute a D1 SQL command (handles local vs remote environment)
 */
function executeD1Command(command: string, silent = false): string {
  const baseCommand = isRemoteEnvironment
    ? `npx wrangler d1 execute AUTH_DB --remote --config wrangler.qa.json --command "${command}"`
    : `npx wrangler d1 execute AUTH_DB --local --persist-to=../../.wrangler/state --command "${command}"`;

  return execSync(baseCommand, {
    cwd: AUTH_APP_PATH,
    encoding: 'utf-8',
    stdio: silent ? 'pipe' : 'inherit',
    env: isRemoteEnvironment
      ? {
          ...process.env,
          CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
          CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
        }
      : process.env,
  });
}

/**
 * Clean up sessions for test users from D1 database
 *
 * Must run BEFORE cleanupTestUsers to avoid orphaned sessions
 */
export async function cleanupTestUserSessions(): Promise<void> {
  console.log('Cleaning up sessions for test users...');

  try {
    // Delete account_sessions for test users (must delete before browser_sessions due to FK)
    executeD1Command(
      "DELETE FROM account_sessions WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@e2e-test.local')"
    );
    console.log('✓ Account sessions for test users cleaned up');

    // Delete browser_sessions for test users
    executeD1Command(
      "DELETE FROM browser_sessions WHERE active_user_id IN (SELECT id FROM users WHERE email LIKE '%@e2e-test.local')"
    );
    console.log('✓ Browser sessions for test users cleaned up');
  } catch (error) {
    console.warn('Warning: Failed to cleanup test user sessions:', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Clean up orphaned sessions (users deleted but sessions remain)
 */
export async function cleanupOrphanedSessions(): Promise<void> {
  console.log('Cleaning up orphaned sessions...');

  try {
    // Delete orphaned account_sessions
    executeD1Command(
      'DELETE FROM account_sessions WHERE user_id NOT IN (SELECT id FROM users)'
    );
    console.log('✓ Orphaned account sessions cleaned up');

    // Delete orphaned browser_sessions
    executeD1Command(
      'DELETE FROM browser_sessions WHERE active_user_id IS NOT NULL AND active_user_id NOT IN (SELECT id FROM users)'
    );
    console.log('✓ Orphaned browser sessions cleaned up');
  } catch (error) {
    console.warn('Warning: Failed to cleanup orphaned sessions:', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Clean up test users from D1 database
 *
 * Removes all users with email addresses containing '@e2e-test.local'
 * This is safe since real users will never have this domain.
 */
export async function cleanupTestUsers(): Promise<void> {
  console.log('Cleaning up test users from D1 database...');
  console.log(`Environment: ${isRemoteEnvironment ? 'Remote (QA)' : 'Local'}`);

  try {
    executeD1Command("DELETE FROM users WHERE email LIKE '%@e2e-test.local'");
    console.log('✓ Test users cleaned up');
  } catch (error) {
    console.warn('Warning: Failed to cleanup test users:', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Get count of test users in database (for diagnostics)
 */
export async function getTestUserCount(): Promise<number> {
  try {
    const output = executeD1Command(
      "SELECT COUNT(*) as count FROM users WHERE email LIKE '%@e2e-test.local'",
      true
    );
    const match = output.match(/"count":\s*(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
  } catch {
    return -1;
  }
}

/**
 * Clean up rate limit entries for test IPs
 *
 * Rate limits are stored in KV with TTL, so they expire automatically.
 */
export async function cleanupRateLimits(): Promise<void> {
  console.log('Cleaning up rate limit entries...');
  console.log('✓ Rate limits will expire naturally (TTL-based)');
}

/**
 * Full cleanup function to run before test suites
 *
 * Called automatically via globalSetup or can be run manually
 */
export async function fullCleanup(): Promise<void> {
  console.log('\n🧹 Starting E2E test cleanup...\n');

  // Get count before cleanup for diagnostics
  const countBefore = await getTestUserCount();
  if (countBefore >= 0) {
    console.log(`📊 Test users before cleanup: ${countBefore}`);
  }

  // Order matters: sessions first (FK constraints), then users
  await cleanupTestUserSessions();
  await cleanupOrphanedSessions();
  await cleanupTestUsers();
  await cleanupRateLimits();

  // Get count after cleanup to verify
  const countAfter = await getTestUserCount();
  if (countAfter >= 0) {
    console.log(`📊 Test users after cleanup: ${countAfter}`);
  }

  console.log('\n✅ E2E test cleanup completed\n');
}
