import type { EmailTheme } from '../../../packages/ui/src/auth-theme/types.ts';
/**
 * Email Templates for Al Ummah Now Authentication
 *
 * Professional, responsive HTML email templates
 */

export interface VerificationEmailData {
  code: string;
  email: string;
  expiryMinutes?: number;
}

/** An Auth theme's `email` section (theme package format v1); unset keys keep the template's own look. */
export type { EmailTheme };

const SAFE = /^(?:#[0-9a-fA-F]{3,8}|\d{1,3}(?:\.\d+)?(?:px|rem|em|%)|0)$/;

/** CSS overrides for the theme's email colours (only validated values). */
export function emailThemeCss(theme: EmailTheme | undefined): string {
  if (!theme) return '';
  const v = (k: keyof EmailTheme) => (theme[k] && SAFE.test(theme[k]!) ? theme[k] : undefined);
  const rules: string[] = [];
  if (v('background')) rules.push(`body { background-color: ${v('background')}; }`);
  if (v('text')) rules.push(`.email-body, .email-body p { color: ${v('text')}; }`);
  const accent = v('buttonBackground');
  if (accent) rules.push(`.email-header { background: ${accent}; } .brand-name, .email-footer a, .code-expiry { color: ${accent}; } .code-container { border-color: ${accent}; }`);
  if (v('buttonText')) rules.push(`.email-header h1 { color: ${v('buttonText')}; }`);
  if (v('buttonRadius')) rules.push(`.code-container { border-radius: ${v('buttonRadius')}; }`);
  return rules.join('\n');
}

/**
 * Generate HTML for verification code email
 */
export function getVerificationCodeTemplate(data: VerificationEmailData, theme?: EmailTheme): string {
  const { code, expiryMinutes = 10 } = data;
  const html = renderVerificationCodeTemplate(code, expiryMinutes);
  if (!theme || Object.keys(theme).length === 0) return html;
  let out = html.replace('</head>', `<style>${emailThemeCss(theme)}</style>\n</head>`);
  if (theme.headerImage && /^https:\/\/[^\s"'<>]+$/.test(theme.headerImage)) {
    out = out.replace(/(<img src=")[^"]*(" alt="Al Ummah Now" class="logo">)/, `$1${theme.headerImage}$2`);
  }
  return out;
}

function renderVerificationCodeTemplate(code: string, expiryMinutes: number): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Your Verification Code</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      line-height: 1.6;
      color: #333333;
      background-color: #f5f5f5;
    }

    .email-wrapper {
      max-width: 600px;
      margin: 0 auto;
      background-color: #ffffff;
    }

    .email-header {
      background: linear-gradient(135deg, #047857 0%, #16a34a 100%);
      padding: 40px 20px;
      text-align: center;
    }

    .logo {
      width: 80px;
      height: 80px;
      margin: 0 auto 15px;
    }

    .email-header h1 {
      color: #ffffff;
      font-size: 28px;
      font-weight: 600;
      margin: 0;
    }

    .email-body {
      padding: 40px 30px;
    }

    .email-body p {
      margin-bottom: 20px;
      color: #555555;
      font-size: 16px;
    }

    .code-container {
      background: linear-gradient(135deg, #f0fdf4 0%, #fef3c7 100%);
      border: 2px dashed #047857;
      border-radius: 8px;
      padding: 30px;
      text-align: center;
      margin: 30px 0;
    }

    .code-label {
      color: #065f46;
      font-size: 14px;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 10px;
      font-weight: 600;
    }

    .code {
      font-size: 36px;
      font-weight: 700;
      color: #047857;
      letter-spacing: 8px;
      font-family: 'Courier New', monospace;
      margin: 10px 0;
      user-select: all;
    }

    .code-expiry {
      color: #999999;
      font-size: 13px;
      margin-top: 15px;
    }

    .security-notice {
      background-color: #fef3c7;
      border-left: 4px solid #eab308;
      padding: 15px;
      margin: 25px 0;
      border-radius: 4px;
    }

    .security-notice p {
      margin: 0;
      color: #854d0e;
      font-size: 14px;
    }

    .security-notice strong {
      font-weight: 600;
    }

    .email-footer {
      background-color: #f8f9fa;
      padding: 30px;
      text-align: center;
      border-top: 1px solid #e0e0e0;
    }

    .email-footer p {
      color: #999999;
      font-size: 13px;
      margin: 5px 0;
    }

    .email-footer a {
      color: #047857;
      text-decoration: none;
    }

    .brand-name {
      color: #047857;
      font-weight: 600;
    }

    @media only screen and (max-width: 600px) {
      .email-header {
        padding: 30px 15px;
      }

      .email-header h1 {
        font-size: 24px;
      }

      .email-body {
        padding: 30px 20px;
      }

      .code {
        font-size: 28px;
        letter-spacing: 4px;
      }

      .code-container {
        padding: 20px;
      }
    }
  </style>
</head>
<body>
  <div class="email-wrapper">
    <div class="email-header">
      <img src="https://al-ummah-now-images.b-cdn.net/favicon_io/android-chrome-192x192.png" alt="Al Ummah Now" class="logo">
      <h1>Al Ummah Now</h1>
    </div>

    <div class="email-body">
      <p>Assalamu Alaikum,</p>

      <p>You requested a verification code to sign in to your <span class="brand-name">Al Ummah Now</span> account. Please use the code below to complete your authentication:</p>

      <div class="code-container">
        <div class="code-label">Your Verification Code</div>
        <div class="code">${code}</div>
        <div class="code-expiry">This code will expire in ${expiryMinutes} minutes</div>
      </div>

      <p>Enter this code on the sign-in page to access your account.</p>

      <div class="security-notice">
        <p><strong>Security Notice:</strong> If you didn't request this code, please ignore this email. Never share your verification code with anyone.</p>
      </div>

      <p>JazakAllahu Khairan,<br><span class="brand-name">Al Ummah Now Team</span></p>
    </div>

    <div class="email-footer">
      <p>© ${new Date().getFullYear()} Al Ummah Now. All rights reserved.</p>
      <p>This is an automated message, please do not reply to this email.</p>
    </div>
  </div>
</body>
</html>
  `.trim();
}

/**
 * Generate plain text version for verification code email
 */
export function getVerificationCodePlainText(data: VerificationEmailData): string {
  const { code, expiryMinutes = 10 } = data;

  return `
Assalamu Alaikum,

You requested a verification code to sign in to your Al Ummah Now account.

Your Verification Code: ${code}

This code will expire in ${expiryMinutes} minutes.

Enter this code on the sign-in page to access your account.

SECURITY NOTICE: If you didn't request this code, please ignore this email. Never share your verification code with anyone.

JazakAllahu Khairan,
Al Ummah Now Team

---
© ${new Date().getFullYear()} Al Ummah Now. All rights reserved.
This is an automated message, please do not reply to this email.
  `.trim();
}

/**
 * Get the subject line for verification code email
 */
export function getVerificationCodeSubject(): string {
  return "Your Al Ummah Now Verification Code";
}
