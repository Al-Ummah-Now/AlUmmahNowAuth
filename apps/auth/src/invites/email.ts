/**
 * The invite email, in ONE language: the one the admin picked next to Send
 * (the invite's locale; a resend may change it). Sent with the same Resend
 * sender as email codes (src/email.ts), in the shared design (src/email/layout.ts).
 *
 * A channel is mentioned only when the admin attached one (the videos admin
 * sends them in the invite's details: `channels: [{ name, action }]`), by name;
 * otherwise the email talks about the creator account only.
 */
import { formatEmailDate, renderEmail, type EmailDoc, type RenderedEmailParts } from '../email/layout';
import type { InviteLocale } from './service';

export interface InviteChannelInfo {
	name: string;
	/** created: a new channel for them; transferred: an existing channel moved to their account */
	action?: 'created' | 'transferred' | string;
}

export interface InviteEmailData {
	email: string;
	name: string | null;
	link: string;
	expiresAt: number;
	note: string | null;
	locale: InviteLocale;
	channels?: InviteChannelInfo[];
}

/** The channel names from an invite's details (as the videos admin stores them). */
export function inviteChannels(details: Record<string, unknown> | null | undefined): InviteChannelInfo[] {
	const list = details && Array.isArray(details.channels) ? details.channels : [];
	return list
		.filter((c): c is { name: string; action?: string } => !!c && typeof c === 'object' && typeof (c as { name?: unknown }).name === 'string' && !!(c as { name: string }).name.trim())
		.map((c) => ({ name: c.name.trim(), action: c.action }));
}

const joinNames = (names: string[], locale: InviteLocale) =>
	new Intl.ListFormat(locale === 'ar' ? 'ar' : 'en', { style: 'long', type: 'conjunction' }).format(names);

const COPY = {
	en: {
		subject: "You're invited to Al Ummah Now",
		preheader: (channels: string | null) => (channels ? `Your creator account and ${channels} are ready. Accept the invite to sign in.` : 'Your creator account is ready. Accept the invite to sign in.'),
		greeting: (name: string | null) => (name ? `Assalamu alaikum ${name},` : 'Assalamu alaikum,'),
		account: 'An Al Ummah Now admin has set up a creator account for you.',
		created: (names: string, n: number) => `It comes with ${n > 1 ? 'the channels' : 'the channel'} ${names}, ready for you to manage.`,
		transferred: (names: string, n: number) => `${n > 1 ? 'The channels' : 'The channel'} ${names} ${n > 1 ? 'have' : 'has'} been moved to your account.`,
		how: (email: string) => `Sign in with ${email}. If you have not set a password yet, choose "Create account" and we will email you a code to confirm it is you.`,
		button: 'Accept the invite',
		note: 'Note from the admin',
		expires: (date: string) => `This link works until ${date}. After that you can still sign in with this email address.`,
		reason: 'You got this email because an Al Ummah Now admin invited this address to a creator account. If you weren\'t expecting it, you can ignore it.',
	},
	ar: {
		subject: 'دعوة للانضمام إلى الأمة الآن',
		preheader: (channels: string | null) => (channels ? `حساب صانع المحتوى الخاص بك جاهز مع ${channels}. اقبل الدعوة لتسجيل الدخول.` : 'حساب صانع المحتوى الخاص بك جاهز. اقبل الدعوة لتسجيل الدخول.'),
		greeting: (name: string | null) => (name ? `السلام عليكم ${name}،` : 'السلام عليكم،'),
		account: 'أنشأ لك أحد مشرفي الأمة الآن حساب صانع محتوى.',
		created: (names: string, n: number) => `ويضم ${n > 1 ? 'القنوات' : 'القناة'} ${names} جاهزةً لتديرها.`,
		transferred: (names: string, n: number) => `ونُقلت إليه ${n > 1 ? 'القنوات' : 'القناة'} ${names}.`,
		how: (email: string) => `سجّل الدخول باستخدام ${email}. إن لم تكن قد عيّنت كلمة مرور بعد، فاختر «إنشاء حساب» وسنرسل إليك رمزًا للتأكد من أنك صاحب البريد.`,
		button: 'قبول الدعوة',
		note: 'ملاحظة من المشرف',
		expires: (date: string) => `يعمل هذا الرابط حتى ${date}. وبعد ذلك يمكنك تسجيل الدخول بهذا البريد الإلكتروني.`,
		reason: 'وصلتك هذه الرسالة لأن أحد مشرفي الأمة الآن دعا هذا العنوان إلى حساب صانع محتوى. إن لم تكن تتوقعها، فيمكنك تجاهلها.',
	},
} as const;

export function inviteEmailDoc(data: InviteEmailData): EmailDoc {
	const locale: InviteLocale = data.locale === 'ar' ? 'ar' : 'en';
	const t = COPY[locale];
	const channels = data.channels ?? [];
	const moved = channels.filter((c) => c.action === 'transferred').map((c) => c.name);
	const made = channels.filter((c) => c.action !== 'transferred').map((c) => c.name);
	const all = channels.length ? joinNames(channels.map((c) => c.name), locale) : null;
	const intro = [t.account, made.length ? t.created(joinNames(made, locale), made.length) : '', moved.length ? t.transferred(joinNames(moved, locale), moved.length) : '']
		.filter(Boolean)
		.join(' ');
	return {
		locale,
		subject: t.subject,
		preheader: t.preheader(all),
		greeting: t.greeting(data.name),
		blocks: [
			{ kind: 'p', text: intro },
			{ kind: 'p', text: t.how(data.email) },
		],
		cta: { label: t.button, url: data.link },
		after: [
			...(data.note ? [{ kind: 'quote' as const, label: t.note, text: data.note }] : []),
			{ kind: 'small', text: t.expires(formatEmailDate(data.expiresAt, locale)) },
		],
		reason: t.reason,
	};
}

export function renderInviteEmail(data: InviteEmailData): RenderedEmailParts {
	return renderEmail(inviteEmailDoc(data));
}

export const inviteEmailSubject = (locale: InviteLocale): string => COPY[locale === 'ar' ? 'ar' : 'en'].subject;
export const inviteEmailHtml = (data: InviteEmailData): string => renderInviteEmail(data).html;
export const inviteEmailText = (data: InviteEmailData): string => renderInviteEmail(data).text;
