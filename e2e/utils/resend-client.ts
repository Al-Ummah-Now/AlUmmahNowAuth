/**
 * Resend API client for retrieving verification emails in E2E tests
 *
 * @see https://resend.com/docs/api-reference/introduction
 */

interface ResendEmailRecord {
  id: string;
  to?: string[];
  subject?: string;
  created_at?: string;
  [key: string]: unknown;
}

export class ResendTestClient {
  private apiKey: string;
  private baseUrl = 'https://api.resend.com';

  constructor(apiKey: string) {
    if (!apiKey) {
      throw new Error('Resend API key is required');
    }
    this.apiKey = apiKey;
  }

  /**
   * Sleep with exponential backoff
   */
  private async sleepWithBackoff(baseMs: number, attempt: number, maxMs = 10000): Promise<void> {
    const delay = Math.min(baseMs * Math.pow(2, attempt - 1), maxMs);
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  /**
   * Retrieves the latest verification email sent to the specified address
   *
   * @param email - Email address to search for
   * @param maxAttempts - Maximum number of retry attempts (default: 10)
   * @param baseDelayMs - Base delay between attempts in milliseconds (default: 1500)
   * @returns HTML content of the verification email, or null if not found
   */
  async getVerificationEmail(
    email: string,
    maxAttempts = 10,
    baseDelayMs = 1500
  ): Promise<string | null> {
    console.log(`Waiting for verification email to ${email} (max ${maxAttempts} attempts)`);

    let rateLimitRetries = 0;
    const maxRateLimitRetries = 5; // Increased from 3 to handle burst rate limits in parallel tests

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        // List recent emails
        const response = await fetch(`${this.baseUrl}/emails`, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
        });

        if (!response.ok) {
          // Handle rate limiting with exponential backoff
          if (response.status === 429) {
            rateLimitRetries++;
            if (rateLimitRetries > maxRateLimitRetries) {
              console.error(`Max rate limit retries (${maxRateLimitRetries}) exceeded`);
              throw new Error('Resend API rate limit exceeded after multiple retries');
            }
            const retryAfter = parseInt(response.headers.get('retry-after') || '2', 10);
            const backoffDelay = Math.max(retryAfter * 1000, 1000 * Math.pow(2, rateLimitRetries));
            console.log(`Rate limited by Resend (${rateLimitRetries}/${maxRateLimitRetries}), waiting ${backoffDelay/1000}s...`);
            await new Promise(resolve => setTimeout(resolve, backoffDelay));
            attempt--; // Don't count rate limit retries against attempts
            continue;
          }
          console.error(`Failed to fetch emails from Resend: ${response.status} ${response.statusText}`);
          throw new Error(`Resend API error: ${response.statusText}`);
        }

        // Reset rate limit counter on success
        rateLimitRetries = 0;

        const data = await response.json();

        // Find verification email for the specified address (most recent first)
        // Sort by created_at descending to get the newest email
        const sortedEmails = (data.data || []).sort((a: ResendEmailRecord, b: ResendEmailRecord) => {
          const dateA = new Date(a.created_at || 0).getTime();
          const dateB = new Date(b.created_at || 0).getTime();
          return dateB - dateA; // Most recent first
        });

        const verificationEmail = sortedEmails.find((emailRecord: ResendEmailRecord) => {
          const matches = emailRecord.to?.includes(email) &&
                 (emailRecord.subject?.toLowerCase().includes('verification') ||
                  emailRecord.subject?.toLowerCase().includes('verify') ||
                  emailRecord.subject?.toLowerCase().includes('code'));
          if (matches) {
            console.log(`Found matching email: to=${emailRecord.to}, subject=${emailRecord.subject}`);
          }
          return matches;
        });

        if (verificationEmail) {
          console.log(`Verification email found for ${email} on attempt ${attempt}`);

          // Fetch the full email content with retry
          const emailContent = await this.fetchEmailContentWithRetry(verificationEmail.id);
          if (emailContent) {
            return emailContent;
          }
          // If content fetch failed, continue to next attempt
          continue;
        }

        console.log(`Verification email not found yet (attempt ${attempt}/${maxAttempts})`);

        // Wait before next attempt with exponential backoff
        if (attempt < maxAttempts) {
          await this.sleepWithBackoff(baseDelayMs, attempt);
        }

      } catch (error) {
        console.error(`Error fetching verification email (attempt ${attempt}):`, error);

        if (attempt === maxAttempts) {
          throw error;
        }

        // Wait before retry with exponential backoff
        await this.sleepWithBackoff(baseDelayMs, attempt);
      }
    }

    console.warn(`Verification email not found for ${email} after ${maxAttempts} attempts`);
    return null;
  }

  /**
   * Fetch email content with retry logic for rate limiting
   */
  private async fetchEmailContentWithRetry(emailId: string, maxRetries = 3): Promise<string | null> {
    for (let retry = 0; retry < maxRetries; retry++) {
      const emailResponse = await fetch(
        `${this.baseUrl}/emails/${emailId}`,
        {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
        }
      );

      if (emailResponse.ok) {
        const emailData = await emailResponse.json();
        return emailData.html || emailData.text || null;
      }

      // Handle rate limiting
      if (emailResponse.status === 429) {
        const backoffDelay = 1000 * Math.pow(2, retry + 1);
        console.log(`Rate limited fetching email content, waiting ${backoffDelay/1000}s... (retry ${retry + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, backoffDelay));
        continue;
      }

      throw new Error(`Failed to fetch email content: ${emailResponse.statusText}`);
    }
    return null;
  }

  /**
   * Extracts the verification code from email HTML content
   *
   * Supports common patterns:
   * - 6-digit numeric codes
   * - Codes in headings, paragraphs, or code blocks
   *
   * @param emailHtml - HTML content of the email
   * @returns Verification code, or null if not found
   */
  extractVerificationCode(emailHtml: string): string | null {
    // Strategy: Find all 6-digit numbers that are NOT part of CSS hex colors

    // First, try to find codes in prominent HTML elements (most reliable)
    const prominentPatterns = [
      /<h[1-6][^>]*>(\d{6})<\/h[1-6]>/i,
      /<div[^>]*class="[^"]*code[^"]*"[^>]*>(\d{6})<\/div>/i,
      /<span[^>]*class="[^"]*code[^"]*"[^>]*>(\d{6})<\/span>/i,
      /<strong>(\d{6})<\/strong>/i,
      /<b>(\d{6})<\/b>/i,
      /code[^>]*>(\d{6})</i,
    ];

    for (const pattern of prominentPatterns) {
      const match = emailHtml.match(pattern);
      if (match) {
        console.log(`Extracted verification code from prominent element: ${match[1]}`);
        return match[1];
      }
    }

    // Find all 6-digit sequences
    const allDigits = emailHtml.match(/\d{6}/g);
    if (!allDigits || allDigits.length === 0) {
      console.warn('No 6-digit sequences found in email');
      return null;
    }

    // Filter out CSS hex colors by checking if preceded by '#'
    const cssColorCodes = new Set(['333333', '555555', '666666', '999999', 'aaaaaa', 'cccccc', 'ffffff', '000000']);
    const nonCssDigits = allDigits.filter(digit => {
      const isLikelyCssColor = cssColorCodes.has(digit.toLowerCase()) ||
        emailHtml.includes(`#${digit}`) ||
        emailHtml.includes(`#${digit.toLowerCase()}`);
      return !isLikelyCssColor;
    });

    if (nonCssDigits.length > 0) {
      // Return the last non-CSS 6-digit number (most likely to be the verification code)
      const code = nonCssDigits[nonCssDigits.length - 1];
      console.log(`Extracted verification code (last non-CSS 6-digit): ${code}`);
      return code;
    }

    // Fallback: return the last 6-digit number
    const code = allDigits[allDigits.length - 1];
    console.log(`Extracted verification code (fallback): ${code}`);
    return code;
  }
}
