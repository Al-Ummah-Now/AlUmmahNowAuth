/**
 * Test Data Generators
 *
 * Utilities for generating consistent test data across E2E tests.
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load .env.test in worker processes (playwright.config.ts only loads in main process)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env.test') });

export interface TestUser {
  email: string;
  role: 'admin' | 'user';
}

/**
 * Generate a unique test email address
 */
export function generateTestEmail(prefix: string = 'test'): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(7);
  return `${prefix}-${timestamp}-${random}@e2e-test.local`;
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
    role: 'user' as const,
  }),
  newUser: () => ({
    email: generateTestEmail('new-user'),
    role: 'user' as const,
  }),
  newAdmin: () => ({
    email: generateTestEmail('new-admin'),
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
