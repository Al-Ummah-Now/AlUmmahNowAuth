import { Resend } from "resend";

export default async function SendEmail(apiKey: string ,from: string, to: string, subject: string, html: string) {
  const resend = new Resend(apiKey);
  const { data, error } = await resend.emails.send({
    from: from,
    to: to,
    subject: subject,
    html: html,
  });
  if (error) {
    console.error("Error sending email:", error);
    return { success: false, error };
  }
  console.log("Email sent successfully:", data);
  return { success: true };
};