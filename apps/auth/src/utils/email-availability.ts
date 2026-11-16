/**
 * Whether Auth can send email (the Resend key resolves). Features that need an
 * emailed code are hidden when it can't (owner rule: if config blocks a
 * feature, that feature is hidden): "Create account" and "Forgot password?"
 * on the sign-in page, the /password/register and /password/change routes
 * (404), and a staff member's first passkey, whose only check is an emailed
 * code (the card is skipped, /passkeys/setup and /passkeys/email-code 404).
 *
 * Computed once per request in index.ts and passed to every consumer. A key
 * that resolves but fails at send time is a real delivery failure and keeps
 * its "We couldn't send the code" message.
 */
import { getSecret } from './secrets';

export interface EmailEnv {
	RESEND_API_KEY?: unknown;
}

export async function isEmailAvailable(env: EmailEnv): Promise<boolean> {
	const key = await getSecret(env.RESEND_API_KEY, 'RESEND_API_KEY', env as Record<string, unknown>);
	return key.trim() !== '';
}

/** The password routes that send a code: register and forgot password. */
const EMAIL_ONLY_PASSWORD_ROUTE = /^\/password\/(register|change)(\/|$)/;

export function isEmailOnlyPasswordRoute(routedPathname: string): boolean {
	return EMAIL_ONLY_PASSWORD_ROUTE.test(routedPathname);
}

/**
 * The sign-in page without "Don't have an account? Register" and
 * "Forgot password?": openauth renders both, and only them, in the login
 * form's footer, so the footer goes.
 */
export function withoutEmailLinks(response: Response): Response {
	return new HTMLRewriter()
		.on('form[data-component="form"] [data-component="form-footer"]', {
			element(el) {
				el.remove();
			},
		})
		.transform(response);
}
