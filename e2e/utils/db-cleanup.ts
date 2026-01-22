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
 * Clean up test users from D1 database
 *
 * Removes all users with email addresses containing '@e2e-test.local'
 * This is safe since real users will never have this domain.
 */
export async function cleanupTestUsers(): Promise<void> {
  console.log('Cleaning up test users from D1 database...');
  console.log(`Environment: ${isRemoteEnvironment ? 'Remote (QA)' : 'Local'}`);

  try {
    if (isRemoteEnvironment) {
      // Remote D1 cleanup using QA config
      execSync(
        `npx wrangler d1 execute AUTH_DB --remote --config wrangler.qa.json --command "DELETE FROM user WHERE email LIKE '%@e2e-test.local'"`,
        {
          cwd: AUTH_APP_PATH,
          stdio: 'pipe',
          env: {
            ...process.env,
            // Ensure wrangler can access Cloudflare API
            CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
            CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
          }
        }
      );
    } else {
      // Local D1 cleanup
      execSync(
        `npx wrangler d1 execute AUTH_DB --local --persist-to=../../.wrangler/state --command "DELETE FROM user WHERE email LIKE '%@e2e-test.local'"`,
        {
          cwd: AUTH_APP_PATH,
          stdio: 'pipe'
        }
      );
    }
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
    let output: string;
    if (isRemoteEnvironment) {
      output = execSync(
        `npx wrangler d1 execute AUTH_DB --remote --config wrangler.qa.json --command "SELECT COUNT(*) as count FROM user WHERE email LIKE '%@e2e-test.local'"`,
        {
          cwd: AUTH_APP_PATH,
          encoding: 'utf-8',
          env: {
            ...process.env,
            CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
            CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
          }
        }
      );
    } else {
      output = execSync(
        `npx wrangler d1 execute AUTH_DB --local --persist-to=../../.wrangler/state --command "SELECT COUNT(*) as count FROM user WHERE email LIKE '%@e2e-test.local'"`,
        {
          cwd: AUTH_APP_PATH,
          encoding: 'utf-8'
        }
      );
    }
    // Parse the count from wrangler output (JSON format)
    const match = output.match(/"count":\s*(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
  } catch {
    return -1; // Error getting count
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
 * Called automatically via globalSetup or can be run manually
 */
export async function fullCleanup(): Promise<void> {
  console.log('\n🧹 Starting E2E test cleanup...\n');

  // Get count before cleanup for diagnostics
  const countBefore = await getTestUserCount();
  if (countBefore >= 0) {
    console.log(`📊 Test users before cleanup: ${countBefore}`);
  }

  await cleanupTestUsers();
  await cleanupTestSessions();
  await cleanupRateLimits();

  // Get count after cleanup to verify
  const countAfter = await getTestUserCount();
  if (countAfter >= 0) {
    console.log(`📊 Test users after cleanup: ${countAfter}`);
  }

  console.log('\n✅ E2E test cleanup completed\n');
}
