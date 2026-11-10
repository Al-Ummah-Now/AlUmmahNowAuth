/**
 * Test Data Generators
 *
 * Utilities for generating consistent test data across E2E tests.
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { recordRunAccount } from './run-accounts';

// Load .env.test (falling back to .env.test.example) in worker processes (playwright.config.ts only loads in main process)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({
  path: [path.resolve(__dirname, '../../.env.test'), path.resolve(__dirname, '../../.env.test.example')],
});

export interface TestUser {
  email: string;
  role: 'admin' | 'member';  // OpenAuth uses 'member' as default role, not 'user'
}

/**
 * A unique address in the legacy format, <prefix>-<ms>-<random>@e2e.alummahnow.net.
 *
 * e2e.alummahnow.net has no MX record. On QA/stage, auth stores codes for this
 * domain in its E2E sink instead of emailing them (apps/auth/src/utils/e2e-sink.ts).
 */
function legacyTestEmail(prefix: string): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(7);
  return `${prefix}-${timestamp}-${random}@e2e.alummahnow.net`;
}

/** Mirrors RUN_USER_EMAIL in apps/auth/src/utils/e2e-sink.ts (the run-account format). */
export const RUN_USER_EMAIL = /^e2e\+\d{1,20}-\d{1,3}-[a-z0-9][a-z0-9-]{0,62}@e2e\.alummahnow\.net$/;

/**
 * A per-run account address for CI: e2e+<run id>-<attempt>-<name>@e2e.alummahnow.net.
 *
 * Signing one up on QA/stage sets the provisioning marker, so the run teardown
 * (e2e/run-users-teardown.ts) and the 24 h sweeper can delete it. Every account a
 * test signs in to is one of these (never a shared/seeded account): a test that
 * signs out everywhere, revokes, resets a password or changes a role only ever
 * ends its own sessions. Guarded by scripts/__tests__/e2e-shared-accounts.test.ts.
 */
export function runAccountEmail(prefix: string, runId: string, attempt = '1'): string {
  const slug = prefix.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'user';
  const unique = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8).padEnd(6, '0')}`;
  return `e2e+${runId}-${attempt}-${slug}-${unique}@e2e.alummahnow.net`;
}

/**
 * Generate a unique address for an account a test signs up (or signs in) through
 * the real sign-up form.
 *
 * In CI (GITHUB_RUN_ID set) this is a per-run account (runAccountEmail) and is
 * recorded for the run teardown; locally it is the legacy unique address.
 */
export function generateTestEmail(prefix: string = 'test'): string {
  const runId = process.env.GITHUB_RUN_ID;
  if (!runId) return legacyTestEmail(prefix);
  const email = runAccountEmail(prefix, runId, process.env.GITHUB_RUN_ATTEMPT || '1');
  recordRunAccount(email);
  return email;
}

/**
 * A unique address for a user the admin dashboard creates (never signed up through
 * the form). Such users never get the run marker, so they keep the legacy format.
 */
export function generateAdminCreatedEmail(prefix: string = 'test'): string {
  return legacyTestEmail(prefix);
}

/**
 * Test user generators
 * All functions generate unique emails to prevent parallel test collisions
 */
export const TEST_USERS = {
  admin: () => ({
    email: generateTestEmail('admin'),
    role: 'admin' as const,
  }),
  user: () => ({
    email: generateTestEmail('user'),
    role: 'member' as const,  // OpenAuth assigns 'member' role to new users
  }),
  // Users the admin dashboard creates
  newUser: () => ({
    email: generateAdminCreatedEmail('new-user'),
    role: 'member' as const,  // OpenAuth assigns 'member' role to new users
  }),
  newAdmin: () => ({
    email: generateAdminCreatedEmail('new-admin'),
    role: 'admin' as const,
  }),
};

/**
 * Test URLs
 * Uses environment variables for QA/CI testing, falls back to localhost for local dev
 */
export const TEST_URLS = {
  authServer: process.env.E2E_AUTH_SERVER_URL || 'http://localhost:3301',
  adminDashboard: process.env.E2E_ADMIN_URL || 'http://localhost:5175',
  profileApp: process.env.E2E_PROFILE_URL || 'http://localhost:3302',
};

/**
 * Mock login code for testing
 * In E2E tests, we'll need to intercept email sending
 */
export const MOCK_LOGIN_CODE = '123456';
