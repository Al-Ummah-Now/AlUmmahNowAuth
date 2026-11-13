/**
 * Passkey emails (AUTH-PASSKEYS), each in one language (en or ar, the page's
 * `?lang=` at the time): the code that confirms a staff member's first
 * passkey, the "passkey added/removed" notices, and the admin setup link.
 */
import SendEmail from '../email';
import { formatEmailDate, renderEmail, type EmailDoc, type EmailLocale } from '../email/layout';
import { logger } from '../logger';
import { requireSecret } from '../utils/secrets';
import { shouldSinkCode, storeSinkCode, type E2ESinkEnv } from '../utils/e2e-sink';

const FROM = 'Al Ummah Now <login@alummahnow.net>';

const COPY = {
	en: {
		codeSubject: 'Your code to add a passkey',
		codePre: 'Enter this code to add a passkey to your Al Ummah Now account.',
		codeIntro: 'Your role on Al Ummah Now needs a passkey. Enter this code on the page to confirm it is you, then add your passkey.',
		codeLabel: 'Your code',
		codeHint: 'It works for 15 minutes.',
		codeReason: 'You got this email because someone asked to add a passkey to this account. If it was not you, change your password.',
		addedSubject: 'A passkey was added to your account',
		addedPre: 'A new passkey can now sign in to your account.',
		added: (name: string) => `The passkey "${name}" was added to your Al Ummah Now account and can now sign in to it.`,
		removedSubject: 'A passkey was removed from your account',
		removedPre: 'A passkey can no longer sign in to your account.',
		removed: (name: string, byAdmin: boolean) =>
			byAdmin ? `An Al Ummah Now admin removed the passkey "${name}" from your account.` : `The passkey "${name}" was removed from your Al Ummah Now account.`,
		notMe: 'If this was not you, review your passkeys and change your password now.',
		review: 'Review your passkeys',
		noticeReason: 'You got this email because the passkeys of your account changed.',
		linkSubject: 'Set up a passkey for your Al Ummah Now account',
		linkPre: 'An admin sent you a link to set up a passkey.',
		link: 'An Al Ummah Now admin sent you this link so you can add a passkey to your account. Sign in, then add your passkey.',
		linkButton: 'Set up a passkey',
		linkExpires: (d: string) => `This link works once, until ${d}.`,
		linkReason: 'You got this email because an Al Ummah Now admin sent you a passkey setup link. If you were not expecting it, ignore it and tell us.',
	},
	ar: {
		codeSubject: 'رمز إضافة مفتاح مرور',
		codePre: 'أدخل هذا الرمز لإضافة مفتاح مرور إلى حسابك في الأمة الآن.',
		codeIntro: 'يحتاج دورك في الأمة الآن إلى مفتاح مرور. أدخل هذا الرمز في الصفحة لتأكيد هويتك، ثم أضف مفتاح المرور.',
		codeLabel: 'رمزك',
		codeHint: 'يعمل لمدة 15 دقيقة.',
		codeReason: 'وصلتك هذه الرسالة لأن أحدًا طلب إضافة مفتاح مرور إلى هذا الحساب. إن لم تكن أنت، فغيّر كلمة المرور.',
		addedSubject: 'أُضيف مفتاح مرور إلى حسابك',
		addedPre: 'يمكن لمفتاح مرور جديد الآن تسجيل الدخول إلى حسابك.',
		added: (name: string) => `أُضيف مفتاح المرور «${name}» إلى حسابك في الأمة الآن، ويمكنه الآن تسجيل الدخول إليه.`,
		removedSubject: 'أُزيل مفتاح مرور من حسابك',
		removedPre: 'لم يعد بإمكان مفتاح مرور تسجيل الدخول إلى حسابك.',
		removed: (name: string, byAdmin: boolean) =>
			byAdmin ? `أزال أحد مشرفي الأمة الآن مفتاح المرور «${name}» من حسابك.` : `أُزيل مفتاح المرور «${name}» من حسابك في الأمة الآن.`,
		notMe: 'إن لم تكن أنت، فراجع مفاتيح المرور وغيّر كلمة المرور الآن.',
		review: 'مراجعة مفاتيح المرور',
		noticeReason: 'وصلتك هذه الرسالة لأن مفاتيح المرور في حسابك تغيّرت.',
		linkSubject: 'إعداد مفتاح مرور لحسابك في الأمة الآن',
		linkPre: 'أرسل إليك أحد المشرفين رابطًا لإعداد مفتاح مرور.',
		link: 'أرسل إليك أحد مشرفي الأمة الآن هذا الرابط لتضيف مفتاح مرور إلى حسابك. سجّل الدخول، ثم أضف مفتاح المرور.',
		linkButton: 'إعداد مفتاح مرور',
		linkExpires: (d: string) => `يعمل هذا الرابط مرة واحدة حتى ${d}.`,
		linkReason: 'وصلتك هذه الرسالة لأن أحد مشرفي الأمة الآن أرسل إليك رابط إعداد مفتاح مرور. إن لم تكن تتوقعه، فتجاهله وأخبرنا.',
	},
} as const;

export type PasskeyEmail =
	| { kind: 'code'; code: string }
	| { kind: 'added'; name: string; hubUrl: string }
	| { kind: 'removed'; name: string; byAdmin: boolean; hubUrl: string }
	| { kind: 'setup-link'; link: string; expiresAt: number };

export function passkeyEmailDoc(email: PasskeyEmail, locale: EmailLocale): EmailDoc {
	const t = COPY[locale === 'ar' ? 'ar' : 'en'];
	switch (email.kind) {
		case 'code':
			return {
				locale,
				subject: t.codeSubject,
				preheader: t.codePre,
				blocks: [
					{ kind: 'p', text: t.codeIntro },
					{ kind: 'code', label: t.codeLabel, code: email.code, hint: t.codeHint },
				],
				reason: t.codeReason,
			};
		case 'added':
			return {
				locale,
				subject: t.addedSubject,
				preheader: t.addedPre,
				blocks: [{ kind: 'p', text: t.added(email.name) }, { kind: 'notice', text: t.notMe, tone: 'warning' }],
				cta: { label: t.review, url: email.hubUrl },
				reason: t.noticeReason,
			};
		case 'removed':
			return {
				locale,
				subject: t.removedSubject,
				preheader: t.removedPre,
				blocks: [{ kind: 'p', text: t.removed(email.name, email.byAdmin) }, { kind: 'notice', text: t.notMe, tone: 'warning' }],
				cta: { label: t.review, url: email.hubUrl },
				reason: t.noticeReason,
			};
		case 'setup-link':
			return {
				locale,
				subject: t.linkSubject,
				preheader: t.linkPre,
				blocks: [{ kind: 'p', text: t.link }],
				cta: { label: t.linkButton, url: email.link },
				after: [{ kind: 'small', text: t.linkExpires(formatEmailDate(email.expiresAt, locale, true)) }],
				reason: t.linkReason,
			};
	}
}

export interface PasskeyEmailEnv extends E2ESinkEnv {
	RESEND_API_KEY?: unknown;
	ENVIRONMENT?: string;
}

/**
 * Sends one passkey email. A code to an E2E address (QA/stage) goes to the
 * test sink instead. Failures are logged, never thrown, except for codes
 * (the page must say the code was not sent).
 */
export async function sendPasskeyEmail(env: PasskeyEmailEnv, to: string, email: PasskeyEmail, locale: EmailLocale): Promise<boolean> {
	try {
		if (email.kind === 'code' && (await shouldSinkCode(env, to))) {
			await storeSinkCode(env, to, email.code);
			return true;
		}
		if (!env.RESEND_API_KEY && env.ENVIRONMENT === 'development') {
			logger.info('[passkeys] Email not sent (no RESEND_API_KEY in development)', { kind: email.kind, to, ...(email.kind === 'code' ? { code: email.code } : {}) });
			return true;
		}
		const apiKey = await requireSecret(env.RESEND_API_KEY as never, 'RESEND_API_KEY', env as unknown as Record<string, unknown>);
		const doc = renderEmail(passkeyEmailDoc(email, locale));
		const subject = passkeyEmailDoc(email, locale).subject;
		const result = await SendEmail({ apiKey, from: FROM, to, subject, html: doc.html, text: doc.text });
		return result.success;
	} catch (error) {
		logger.error('[passkeys] Could not send email', { kind: email.kind, error: error instanceof Error ? error.message : String(error) });
		return false;
	}
}
