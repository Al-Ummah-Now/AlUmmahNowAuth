/**
 * Test Data Generators
 *
 * Utilities for generating consistent test data across E2E tests.
 */

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
 * Predefined test users
 */
export const TEST_USERS = {
  admin: {
    email: 'admin-e2e-test@example.com',
    role: 'admin' as const,
  },
  user: {
    email: 'user-e2e-test@example.com',
    role: 'user' as const,
  },
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
 */
export const TEST_URLS = {
  authServer: 'http://localhost:8787',
  adminDashboard: 'http://localhost:5175',
  profileApp: 'http://localhost:8788',
};

/**
 * Mock login code for testing
 * In E2E tests, we'll need to intercept email sending
 */
export const MOCK_LOGIN_CODE = '123456';
