import { Resend } from "resend";
import * as v from 'valibot';

const EmailSchema = v.pipe(v.string(), v.email());

/**
 * Send email with retry logic and validation
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
  maxRetries: number = 3
): Promise<{ success: boolean; error?: any }> {
  // Validate email addresses
  try {
    v.parse(EmailSchema, from);
    v.parse(EmailSchema, to);
  } catch (validationError) {
    console.error("Invalid email address:", validationError);
    throw new Error(`Invalid email address: ${validationError instanceof Error ? validationError.message : String(validationError)}`);
  }

  const resend = new Resend(apiKey);
  let lastError: any = null;
  let attempt = 0;

  while (attempt < maxRetries) {
    attempt++;
    try {
      console.log(`Attempting to send email (attempt ${attempt}/${maxRetries})`, { to, subject });

      const { data, error } = await resend.emails.send({
        from: from,
        to: to,
        subject: subject,
        html: html,
      });

      if (error) {
        lastError = error;
        console.error(`Error sending email (attempt ${attempt}/${maxRetries}):`, error);

        // If we haven't exhausted retries, wait before retry with exponential backoff
        if (attempt < maxRetries) {
          const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 5000); // Max 5s
          console.log(`Retrying in ${backoffMs}ms...`);
          await new Promise(resolve => setTimeout(resolve, backoffMs));
          continue;
        }
      } else {
        console.log("Email sent successfully:", data);
        return { success: true };
      }
    } catch (error) {
      lastError = error;
      console.error(`Exception sending email (attempt ${attempt}/${maxRetries}):`, error);

      // If we haven't exhausted retries, wait before retry
      if (attempt < maxRetries) {
        const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
        console.log(`Retrying in ${backoffMs}ms...`);
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        continue;
      }
    }
  }

  // All retries exhausted
  console.error(`Failed to send email after ${maxRetries} attempts`);
  throw new Error(`Unable to send email after ${maxRetries} attempts. Please try again later.`);
};