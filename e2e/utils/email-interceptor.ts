/**
 * Email Interceptor for E2E Tests
 *
 * Retrieves email verification codes from the auth server's test endpoint.
 * Implements retry/polling to handle async email processing.
 */

import { Page } from '@playwright/test';
import { TEST_URLS } from './test-data';

/**
 * Configuration for email polling
 */
const POLL_CONFIG = {
  maxAttempts: 10,
  intervalMs: 500,
  timeoutMs: 5000,
};

/**
 * Sleep helper
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Set up email interception for a page
 *
 * This retrieves email codes from the auth server's test endpoint.
 * Implements polling with retries to handle async email processing.
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

      // Poll for the verification code with retries
      for (let attempt = 1; attempt <= POLL_CONFIG.maxAttempts; attempt++) {
        try {
          const response = await page.request.get(
            `${TEST_URLS.authServer}/test/email/${encodeURIComponent(emailToCheck)}`
          );

          if (response.ok()) {
            const data = await response.json();
            if (data.code) {
              console.log(`Retrieved verification code for ${emailToCheck} on attempt ${attempt}`);
              return data.code;
            }
          }

          // If we got a 404 or no code, the email hasn't been processed yet
          if (attempt < POLL_CONFIG.maxAttempts) {
            console.log(`Waiting for email code (attempt ${attempt}/${POLL_CONFIG.maxAttempts})...`);
            await sleep(POLL_CONFIG.intervalMs);
          }
        } catch (error) {
          console.error(`Error on attempt ${attempt}:`, error);
          if (attempt < POLL_CONFIG.maxAttempts) {
            await sleep(POLL_CONFIG.intervalMs);
          }
        }
      }

      console.error(`Failed to retrieve email code for ${emailToCheck} after ${POLL_CONFIG.maxAttempts} attempts`);
      return null;
    },
  };
}
