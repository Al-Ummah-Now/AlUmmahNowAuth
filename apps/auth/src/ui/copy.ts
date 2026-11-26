/** Copy Auth overrides in OpenAuth's password pages (every locale). */

/** The email-code field's label: points the user to their inbox. */
export const CODE_INPUT_LABEL = {
	en: 'Code (check your inbox)',
	ar: 'الرمز (تحقّق من بريدك الوارد)',
} as const;

/**
 * Everything Auth sets in OpenAuth's password pages, per language (PasswordUI `copy`, which wins
 * over OpenAuth's own translation). The code page's footer is `code_return` + `login` lowercased:
 * "Back to sign in" / «العودة إلى تسجيل الدخول», as on the sign-in link page (sign-in-link/routes.ts).
 * English uses typographic apostrophes, like Auth's own pages.
 */
export const PASSWORD_COPY = {
	en: {
		input_code: CODE_INPUT_LABEL.en,
		register_prompt: 'Don’t have an account?',
		login: 'Sign in',
	},
	ar: {
		input_code: CODE_INPUT_LABEL.ar,
		login: 'تسجيل الدخول',
	},
} as const satisfies Record<'en' | 'ar', Record<string, string>>;

export function sendCodeRateLimitMessage(locale: keyof typeof PASSWORD_COPY, retryAfterSeconds: number): string {
	const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
	if (locale === 'en') {
		return `Too many codes requested. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
	}

	let wait = `${minutes} دقيقة`;
	if (minutes === 1) wait = 'دقيقة واحدة';
	else if (minutes === 2) wait = 'دقيقتين';
	else if (minutes <= 10) wait = `${minutes} دقائق`;
	return `طُلبت رموز كثيرة جدًا. يُرجى الانتظار ${wait} ثم المحاولة مرة أخرى.`;
}
