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

const E2E_CODE_SINK_SECRET = process.env.E2E_CODE_SINK_SECRET;
const AUTH_SERVER_URL = process.env.E2E_AUTH_SERVER_URL || 'http://localhost:3301';
const E2E_DOMAIN = '@e2e.alummahnow.net';

/**
 * Reads a code from auth's E2E sink (QA/stage; apps/auth/src/utils/e2e-sink.ts).
 * consume=1 deletes it on read, so the next call waits for the next code sent.
 */
async function readSinkCode(email: string, timeoutMs = 20000): Promise<string | null> {
  const url = `${AUTH_SERVER_URL}/test/email/${encodeURIComponent(email)}?consume=1`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(url, { headers: { 'X-E2E-Secret': E2E_CODE_SINK_SECRET ?? '' } });
    if (res.ok) {
      const body = (await res.json()) as { code?: string };
      if (body.code) return body.code;
    } else if (res.status !== 404 || !(await res.text()).includes('No email found')) {
      // 404 without the JSON body means the route rejected us (wrong secret or sink not deployed)
      throw new Error(`E2E code sink request failed: ${res.status} (check E2E_CODE_SINK_SECRET and the auth deployment)`);
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return null;
}

/**
 * True if auth's E2E sink holds a code for `email` (read without consuming).
 * null when the sink is not configured for this run.
 */
export async function sinkHasCode(email: string): Promise<boolean | null> {
  if (!E2E_CODE_SINK_SECRET || !email.toLowerCase().endsWith(E2E_DOMAIN)) return null;
  const res = await fetch(`${AUTH_SERVER_URL}/test/email/${encodeURIComponent(email)}`, {
    headers: { 'X-E2E-Secret': E2E_CODE_SINK_SECRET },
  });
  if (res.ok) return true;
  if (res.status === 404 && (await res.text()).includes('No email found')) return false;
  throw new Error(`E2E code sink request failed: ${res.status}`);
}

/**
 * Set up email interception: the auth E2E sink for @e2e.alummahnow.net addresses
 * when E2E_CODE_SINK_SECRET is set, otherwise the Resend API.
 *
 * @returns Function to get the last login code
 */
export function setupEmailInterception(): {
  getLastLoginCode: (email: string) => Promise<string | null>;
} {
  if (!RESEND_API_KEY && !E2E_CODE_SINK_SECRET) {
    console.warn('Neither E2E_CODE_SINK_SECRET nor RESEND_API_KEY is set - email interception will not work');
  }

  const resendClient = RESEND_API_KEY ? new ResendTestClient(RESEND_API_KEY) : null;

  return {
    getLastLoginCode: async (email: string): Promise<string | null> => {
      if (E2E_CODE_SINK_SECRET && email.toLowerCase().endsWith(E2E_DOMAIN)) {
        return readSinkCode(email);
      }

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
