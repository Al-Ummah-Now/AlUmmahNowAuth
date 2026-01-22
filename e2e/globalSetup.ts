/**
 * Playwright Global Setup
 *
 * Runs once before all E2E tests to clean up stale test data.
 * This prevents test user accumulation that causes D1 slowdowns.
 *
 * In CI, cleanup is handled by the deploy-qa workflow step (runs once before
 * all parallel jobs). Local runs use this globalSetup.
 */

import { fullCleanup } from './utils/db-cleanup';

async function globalSetup(): Promise<void> {
  console.log('\n🚀 Running Playwright global setup...\n');

  // In CI, cleanup is handled by deploy-qa job before parallel E2E jobs start
  // This prevents multiple shards from racing on DELETE queries
  if (process.env.CI) {
    console.log('⏭️  Skipping cleanup in CI - handled by deploy-qa workflow step\n');
    return;
  }

  // Clean up any leftover test users from previous runs
  // This is critical for preventing database bloat and SQLITE_BUSY errors
  await fullCleanup();

  console.log('\n✅ Global setup complete - ready for tests\n');
}

export default globalSetup;
