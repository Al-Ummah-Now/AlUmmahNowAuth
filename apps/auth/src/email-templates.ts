import type { EmailTheme } from '../../../packages/ui/src/auth-theme/types.ts';
import { renderEmail, type EmailDoc, type EmailLocale, type RenderedEmailParts } from './email/layout';
/**
 * The email-code email (src/email/layout.ts design), in the language of the
 * page the user clicked from (?lang=ar, else English; never Accept-Language).
 *
 * OpenAuth's password provider sends a code from two pages only, so the copy
 * says which one: creating an account (/password/register) or resetting a
 * forgotten password (/password/change).
 */

export type CodePurpose = 'register' | 'reset';

export interface VerificationEmailData {
	code: string;
	email: string;
	expiryMinutes?: number;
	locale?: EmailLocale;
	purpose?: CodePurpose;
}

/** An Auth theme's `email` section (theme package format v1); unset keys keep the design's own look. */
export type { EmailTheme };

/** /password/register → register; /password/change (forgot password) → reset. */
export function codePurposeOf(pathname: string): CodePurpose {
	return pathname.includes('/register') ? 'register' : 'reset';
}

const COPY = {
	en: {
		subject: { register: 'Your Al Ummah Now code to create your account', reset: 'Your Al Ummah Now code to reset your password' },
		preheader: (code: string, min: number) => `Your code is ${code}. It works for ${min} minutes.`,
		greeting: 'Assalamu alaikum,',
		intro: {
			register: () => 'Use this code to confirm your email address and finish creating your Al Ummah Now account.',
			reset: () => 'Use this code to choose a new password for your Al Ummah Now account.',
		},
		label: 'Your code',
		hint: (min: number) => `It works for ${min} minutes, once.`,
		enter: 'Enter it on the page where you asked for it.',
		notice: "Didn't ask for this? You can ignore this email: nothing changes without the code. Never share it with anyone, including people who say they are from Al Ummah Now.",
		reason: { register: 'You got this email because someone started creating an Al Ummah Now account with this address.', reset: 'You got this email because someone asked to reset the password of the Al Ummah Now account with this address.' },
	},
	ar: {
		subject: { register: 'رمزك لإنشاء حسابك في الأمة الآن', reset: 'رمزك لإعادة تعيين كلمة المرور في الأمة الآن' },
		preheader: (code: string, min: number) => `رمزك هو ${code}، وهو صالح لمدة ${min} دقيقة.`,
		greeting: 'السلام عليكم،',
		intro: {
			register: () => 'استخدم هذا الرمز لتأكيد بريدك الإلكتروني وإكمال إنشاء حسابك في الأمة الآن.',
			reset: () => 'استخدم هذا الرمز لاختيار كلمة مرور جديدة لحسابك في الأمة الآن.',
		},
		label: 'رمزك',
		hint: (min: number) => `صالح لمدة ${min} دقيقة، ولمرة واحدة.`,
		enter: 'أدخله في الصفحة التي طلبته منها.',
		notice: 'لم تطلب هذا الرمز؟ يمكنك تجاهل هذه الرسالة، فلن يتغير شيء من دونه. لا تشارك الرمز مع أحد، حتى مع من يقول إنه من الأمة الآن.',
		reason: { register: 'وصلتك هذه الرسالة لأن أحدًا بدأ إنشاء حساب في الأمة الآن بهذا العنوان.', reset: 'وصلتك هذه الرسالة لأن أحدًا طلب إعادة تعيين كلمة مرور حساب الأمة الآن المرتبط بهذا العنوان.' },
	},
} as const;

export function verificationCodeDoc(data: VerificationEmailData, theme?: EmailTheme): EmailDoc {
	const locale: EmailLocale = data.locale === 'ar' ? 'ar' : 'en';
	const purpose: CodePurpose = data.purpose ?? 'register';
	const min = data.expiryMinutes ?? 15;
	const t = COPY[locale];
	return {
		locale,
		subject: t.subject[purpose],
		preheader: t.preheader(data.code, min),
		greeting: t.greeting,
		blocks: [
			{ kind: 'p', text: t.intro[purpose]() },
			{ kind: 'code', label: t.label, code: data.code, hint: t.hint(min) },
			{ kind: 'p', text: t.enter },
			{ kind: 'notice', text: t.notice, tone: 'warning' },
		],
		reason: t.reason[purpose],
		theme: theme && Object.keys(theme).length ? theme : undefined,
	};
}

export function renderVerificationCodeEmail(data: VerificationEmailData, theme?: EmailTheme): RenderedEmailParts {
	return renderEmail(verificationCodeDoc(data, theme));
}

/** HTML part (kept for callers of the old API). */
export function getVerificationCodeTemplate(data: VerificationEmailData, theme?: EmailTheme): string {
	return renderVerificationCodeEmail(data, theme).html;
}

export function getVerificationCodePlainText(data: VerificationEmailData): string {
	return renderVerificationCodeEmail(data).text;
}

export function getVerificationCodeSubject(data: Pick<VerificationEmailData, 'locale' | 'purpose'> = {}): string {
	return COPY[data.locale === 'ar' ? 'ar' : 'en'].subject[data.purpose ?? 'register'];
}
