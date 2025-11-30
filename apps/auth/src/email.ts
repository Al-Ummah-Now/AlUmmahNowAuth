import { Resend } from "resend";
import * as v from 'valibot';

const EmailSchema = v.pipe(v.string(), v.email());

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
    console.error("Invalid email address:", validationError);
    throw new Error(`Invalid email address: ${validationError instanceof Error ? validationError.message : String(validationError)}`);
  }

  const resend = new Resend(options.apiKey);
  let _lastError: unknown = null;
  let attempt = 0;

  while (attempt < maxRetries) {
    attempt++;
    try {
      console.debug(`Attempting to send email (attempt ${attempt}/${maxRetries})`, { to: options.to, subject: options.subject });

      const emailPayload: Parameters<typeof resend.emails.send>[0] = {
        from: options.from,
        to: options.to,
        subject: options.subject,
        html: options.html,
      };

      // Include plain text version if provided
      if (options.text) {
        emailPayload.text = options.text;
      }

      const { data, error } = await resend.emails.send(emailPayload);

      if (error) {
        _lastError = error;
        console.error(`Error sending email (attempt ${attempt}/${maxRetries}):`, error);

        // If we haven't exhausted retries, wait before retry with exponential backoff
        if (attempt < maxRetries) {
          const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 5000); // Max 5s
          console.info(`Retrying in ${backoffMs}ms...`);
          await new Promise(resolve => setTimeout(resolve, backoffMs));
          continue;
        }
      } else {
        console.info("Email sent successfully:", data);
        return { success: true, emailId: data.id };
      }
    } catch (error) {
      _lastError = error;
      console.error(`Exception sending email (attempt ${attempt}/${maxRetries}):`, error);

      // If we haven't exhausted retries, wait before retry
      if (attempt < maxRetries) {
        const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
        console.info(`Retrying in ${backoffMs}ms...`);
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        continue;
      }
    }
  }

  // All retries exhausted
  console.error(`Failed to send email after ${maxRetries} attempts`);
  throw new Error(`Unable to send email after ${maxRetries} attempts. Please try again later.`);
};