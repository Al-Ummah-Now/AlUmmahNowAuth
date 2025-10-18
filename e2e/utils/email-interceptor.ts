/**
 * Email Interceptor for E2E Tests
 *
 * Retrieves email verification codes from the auth server's test endpoint.
 */

import { Page } from '@playwright/test';
import { TEST_URLS } from './test-data';

/**
 * Set up email interception for a page
 *
 * This retrieves email codes from the auth server's test endpoint.
 *
 * @param page - Playwright page object
 * @returns Function to get the last login code
 */
export function setupEmailInterception(page: Page): {
  getLastLoginCode: (email?: string) => Promise<string | null>;
} {
  let lastEmail: string | null = null;

  return {
    getLastLoginCode: async (email?: string): Promise<string | null> => {
      const emailToCheck = email || lastEmail;
      if (!emailToCheck) {
        return null;
      }

      lastEmail = emailToCheck;

      try {
        // Call the test endpoint to retrieve the verification code
        const response = await page.request.get(`${TEST_URLS.authServer}/test/email/${encodeURIComponent(emailToCheck)}`);

        if (!response.ok()) {
          console.error(`Failed to retrieve email code for ${emailToCheck}: ${response.status()}`);
          return null;
        }

        const data = await response.json();
        return data.code || null;
      } catch (error) {
        console.error(`Error retrieving email code for ${emailToCheck}:`, error);
        return null;
      }
    },
  };
}
