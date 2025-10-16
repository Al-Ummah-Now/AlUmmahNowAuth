/**
 * Email Interceptor for E2E Tests
 *
 * Captures email sending requests and extracts login codes for testing.
 */

import { Page } from '@playwright/test';

/**
 * Captured email data
 */
export interface CapturedEmail {
  to: string;
  from: string;
  subject: string;
  body: string;
  code?: string; // Extracted login code
}

/**
 * Set up email interception for a page
 *
 * This intercepts requests to the Resend API and captures the email content.
 *
 * @param page - Playwright page object
 * @returns Function to get captured emails
 */
export function setupEmailInterception(page: Page): {
  getCapturedEmails: () => CapturedEmail[];
  getLastLoginCode: () => string | null;
} {
  const capturedEmails: CapturedEmail[] = [];

  // Intercept requests to Resend API
  page.route('https://api.resend.com/emails', async (route) => {
    const request = route.request();
    const postData = request.postDataJSON();

    // Extract email data
    const email: CapturedEmail = {
      to: postData.to,
      from: postData.from,
      subject: postData.subject,
      body: postData.html || postData.text,
    };

    // Extract login code from email body
    const codeMatch = email.body.match(/(?:code is|code:)\s*(\d{6})/i);
    if (codeMatch) {
      email.code = codeMatch[1];
    }

    capturedEmails.push(email);

    // Complete the request successfully (mock response)
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: 'mock-email-id' }),
    });
  });

  return {
    getCapturedEmails: () => capturedEmails,
    getLastLoginCode: () => {
      const lastEmail = capturedEmails[capturedEmails.length - 1];
      return lastEmail?.code || null;
    },
  };
}
