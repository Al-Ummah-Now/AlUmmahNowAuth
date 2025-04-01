import { env } from "cloudflare:workers";
import { Resend } from "resend";

type EnvType = {
  RESEND_API_KEY: string;
};

export default async function SendEmail(from: string, to: string, subject: string, html: string) {
  const envV = env as EnvType;
  console.log("Sending email with Resend API key:", envV.RESEND_API_KEY);
  const resend = new Resend(envV.RESEND_API_KEY);
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