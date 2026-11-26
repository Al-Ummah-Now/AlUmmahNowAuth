import { Resend } from "resend";
import * as v from 'valibot';
import { logger } from './logger';

const EmailSchema = v.pipe(v.string(), v.email());
const MAX_RETRY_DELAY_MS = 5000;

function retryAfterMs(header: string | undefined): number | undefined {
  const value = header?.trim();
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/**
 * Extract email address from RFC 5322 format
 * Supports both "Name <email@example.com>" and "email@example.com" formats
 */
function extractEmailAddress(emailString: string): string {
  const match = emailString.match(/<(.+)>/);
  return match ? match[1] : emailString;
}

export interface SendEmailOptions {
  apiKey: string;
  from: string;
  to: string;
  subject: string;
  html: string;
  text?: string;
  maxRetries?: number;
}

/**
 * Send email with retry logic and validation
 * @param options Email options including API key, addresses, subject, HTML and optional text
 * @returns Promise with success status
 */
export default async function SendEmail(
  options: SendEmailOptions
): Promise<{ success: boolean; emailId?: string; error?: unknown }>;

/**
 * Send email with retry logic and validation (legacy signature)
 * @deprecated Use the options object instead
 * @param apiKey Resend API key
 * @param from From email address
 * @param to To email address
 * @param subject Email subject
 * @param html Email HTML content
 * @param maxRetries Maximum number of retry attempts (default: 3)
 * @returns Promise with success status
 */
export default async function SendEmail(
  apiKey: string,
  from: string,
  to: string,
  subject: string,
  html: string,
  maxRetries?: number
): Promise<{ success: boolean; emailId?: string; error?: unknown }>;

export default async function SendEmail(
  apiKeyOrOptions: string | SendEmailOptions,
  from?: string,
  to?: string,
  subject?: string,
  html?: string,
  maxRetries: number = 3
): Promise<{ success: boolean; emailId?: string; error?: unknown }> {
  // Handle both signatures
  let options: SendEmailOptions;
  if (typeof apiKeyOrOptions === 'string') {
    // Legacy signature
    options = {
      apiKey: apiKeyOrOptions,
      from: from!,
      to: to!,
      subject: subject!,
      html: html!,
      maxRetries,
    };
  } else {
    // New options object
    options = apiKeyOrOptions;
    maxRetries = options.maxRetries ?? 3;
  }
  // Extract and validate email addresses (supports "Name <email>" format)
  const fromEmail = extractEmailAddress(options.from);
  const toEmail = extractEmailAddress(options.to);

  try {
    v.parse(EmailSchema, fromEmail);
    v.parse(EmailSchema, toEmail);
  } catch (validationError) {
    logger.error("Invalid email address", { error: validationError });
    throw new Error(`Invalid email address: ${validationError instanceof Error ? validationError.message : String(validationError)}`, { cause: validationError });
  }

  const resend = new Resend(options.apiKey);
  const emailPayload: Parameters<typeof resend.emails.send>[0] = {
    from: options.from,
    to: options.to,
    subject: options.subject,
    html: options.html,
    ...(options.text ? { text: options.text } : {}),
  };
  let lastError: unknown;
  let attempt = 0;

  while (attempt < maxRetries) {
    attempt++;
    let backoffMs = Math.min(1000 * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);
    try {
      logger.debug('Attempting to send email', { attempt, maxRetries, to: options.to, subject: options.subject });
      const { data, error, headers } = await resend.emails.send(emailPayload);
      if (!error) {
        logger.info('Email sent successfully', { emailId: data.id });
        return { success: true, emailId: data.id };
      }

      lastError = error;
      const status = error.statusCode;
      logger.error('Error sending email', { attempt, maxRetries, error });

      // The SDK forwards JSON errors as-is and uses application_error with
      // a null status for a network failure.
      const rateLimited = status === 429 || (status == null && error.name === 'rate_limit_exceeded');
      const transient = status == null
        ? error.name === 'application_error' || error.name === 'internal_server_error'
        : status >= 500 && status < 600;
      if (!rateLimited && !transient) break;
      if (rateLimited) {
        backoffMs = retryAfterMs(headers?.['retry-after']) ?? backoffMs;
        // End this send if Resend asks us to wait longer than the in-request budget.
        if (backoffMs > MAX_RETRY_DELAY_MS) break;
      }
    } catch (error) {
      lastError = error;
      logger.error('Exception sending email', { attempt, maxRetries, error });
    }

    if (attempt < maxRetries) {
      logger.info('Retrying email send', { backoffMs });
      await new Promise(resolve => setTimeout(resolve, backoffMs));
    }
  }

  logger.error('Failed to send email', { attempt, maxRetries });
  throw new Error(`Unable to send email after ${attempt} ${attempt === 1 ? 'attempt' : 'attempts'}. Please try again later.`, { cause: lastError });
}
