/**
 * Email Interceptor for E2E Tests
 *
 * Retrieves email verification codes using the Resend API.
 * This allows E2E tests to verify actual email delivery and extract codes.
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { ResendTestClient } from './resend-client';

// Load .env.test in worker processes (playwright.config.ts only loads in main process)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env.test') });

// Resend API key from environment
const RESEND_API_KEY = process.env.RESEND_API_KEY || process.env.E2E_RESEND_API_KEY;

/**
 * Set up email interception using Resend API
 *
 * @returns Function to get the last login code
 */
export function setupEmailInterception(): {
  getLastLoginCode: (email: string) => Promise<string | null>;
} {
  if (!RESEND_API_KEY) {
    console.warn('RESEND_API_KEY not set - email interception will not work');
  }

  const resendClient = RESEND_API_KEY ? new ResendTestClient(RESEND_API_KEY) : null;

  return {
    getLastLoginCode: async (email: string): Promise<string | null> => {
      if (!resendClient) {
        console.error('Resend client not initialized - RESEND_API_KEY is missing');
        return null;
      }

      try {
        // Get the verification email from Resend
        const emailHtml = await resendClient.getVerificationEmail(email);

        if (!emailHtml) {
          console.error(`No verification email found for ${email}`);
          return null;
        }

        // Extract the verification code from the email
        const code = resendClient.extractVerificationCode(emailHtml);

        if (!code) {
          console.error(`Could not extract verification code from email for ${email}`);
          return null;
        }

        return code;
      } catch (error) {
        console.error(`Error getting verification code for ${email}:`, error);
        return null;
      }
    },
  };
}
