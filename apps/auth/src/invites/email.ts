/**
 * The invite email, in ONE language: the one the admin picked next to Send
 * (the invite's locale; a resend may change it). Sent with the same Resend
 * sender as email codes (src/email.ts), in the shared design (src/email/layout.ts).
 *
 * The words are the videos admin's (Settings › Emails › Creator invite): its
 * create and resend requests carry `emailCopy`, the template's current text in
 * the invite's language with {name}, {email}, {channels} and {expires}
 * placeholders. BUILT_IN_COPY below is only an emergency default for a request
 * without usable copy (an older admin-api, a missing template), and every use of
 * it is logged. Twin builder: AlUmmahNow apps/admin-api/src/lib/email/invite.ts
 * (the editor's preview and test email); keep the two identical.
 *
 * A channel is mentioned only when the admin attached one (the videos admin
 * sends them in the invite's details: `channels: [{ name, action }]`), by name;
 * otherwise the email talks about the creator account only.
 *
 * A video is shown when the admin picked one (details `video`, resolved by the videos admin at each
 * send: gone, private or hidden videos are not sent). Email cannot play video, so it is a picture card
 * linking to the watch page in the email's language.
 */
import { formatList } from '../../../../packages/ui/src/format.ts';
import { formatEmailDate, renderEmail, type EmailDoc, type RenderedEmailParts } from '../email/layout';
import type { InviteLocale } from './service';

export interface InviteChannelInfo {
	name: string;
	/** created: a new channel for them; transferred: an existing channel moved to their account */
	action?: 'created' | 'transferred' | string;
}

export interface InviteVideoInfo {
	title: string;
	channel: string | null;
	/** Stable https picture (the web app's /og/v/<id>.jpg), never a signed URL */
	imageUrl: string;
	/** The watch page per language */
	urls: { en: string; ar: string };
}

export interface InviteEmailData {
	email: string;
	name: string | null;
	link: string;
	expiresAt: number;
	note: string | null;
	locale: InviteLocale;
	channels?: InviteChannelInfo[];
	video?: InviteVideoInfo | null;
}

/** The channel names from an invite's details (as the videos admin stores them). */
export function inviteChannels(details: Record<string, unknown> | null | undefined): InviteChannelInfo[] {
	const list = details && Array.isArray(details.channels) ? details.channels : [];
	return list
		.filter((c): c is { name: string; action?: string } => !!c && typeof c === 'object' && typeof (c as { name?: unknown }).name === 'string' && !!(c as { name: string }).name.trim())
		.map((c) => ({ name: c.name.trim(), action: c.action }));
}

const HTTPS = /^https:\/\/[^\s"'<>]+$/;

/** The video from an invite's details (or a resend's `video`), when it is complete and every URL is https. */
export function inviteVideo(value: unknown): InviteVideoInfo | null {
	if (!value || typeof value !== 'object') return null;
	const v = value as Record<string, unknown>;
	const urls = (v.urls && typeof v.urls === 'object' ? v.urls : {}) as Record<string, unknown>;
	const title = typeof v.title === 'string' ? v.title.trim().slice(0, 200) : '';
	const ok = (u: unknown): u is string => typeof u === 'string' && HTTPS.test(u);
	if (!title || !ok(v.imageUrl) || !ok(urls.en) || !ok(urls.ar)) return null;
	const channel = typeof v.channel === 'string' && v.channel.trim() ? v.channel.trim().slice(0, 100) : null;
	return { title, channel, imageUrl: v.imageUrl, urls: { en: urls.en, ar: urls.ar } };
}

const joinNames = (names: string[], locale: InviteLocale) =>
	formatList(names, locale);

/** The copy fields of the creator invite (shared-types CREATOR_INVITE_TEMPLATE in the videos repo). */
export const INVITE_COPY_FIELDS = [
	'subject',
	'preheader',
	'preheaderChannels',
	'greeting',
	'greetingNoName',
	'account',
	'createdOne',
	'createdMany',
	'transferredOne',
	'transferredMany',
	'how',
	'button',
	'videoIntro',
	'videoAlt',
	'noteLabel',
	'expires',
	'reason',
] as const;
export type InviteCopyField = (typeof INVITE_COPY_FIELDS)[number];
export type InviteCopy = Record<InviteCopyField, string>;

/** Emergency default only (see the header). How/expires follow the link-signs-you-in flow (#434); the admin template should say the same. */
export const BUILT_IN_COPY: Record<InviteLocale, InviteCopy> = {
	en: {
		subject: "You're invited to Al Ummah Now",
		preheader: 'Your creator account is ready. Accept the invite to sign in.',
		preheaderChannels: 'Your creator account and {channels} are ready. Accept the invite to sign in.',
		greeting: 'Assalamu alaikum {name},',
		greetingNoName: 'Assalamu alaikum,',
		account: 'An Al Ummah Now admin has set up a creator account for you.',
		createdOne: 'It comes with the channel {channels}, ready for you to manage.',
		createdMany: 'It comes with the channels {channels}, ready for you to manage.',
		transferredOne: 'The channel {channels} has been moved to your account.',
		transferredMany: 'The channels {channels} have been moved to your account.',
		how: "Accept the invite to sign in as {email}. You don't need a password: the button signs you in, and you can add a passkey (Face ID or fingerprint) right after.",
		button: 'Accept the invite',
		videoIntro: 'They also shared this video with you:',
		videoAlt: 'Play "{title}" on Al Ummah Now',
		noteLabel: 'Note from the admin',
		expires: 'This link works once, until {expires}. If it has expired or was already used, open it anyway and ask for a new one.',
		reason: "You got this email because an Al Ummah Now admin invited this address to a creator account. If you weren't expecting it, you can ignore it.",
	},
	ar: {
		subject: 'دعوة للانضمام إلى الأمة الآن',
		preheader: 'حساب صانع المحتوى الخاص بك جاهز. اقبل الدعوة لتسجيل الدخول.',
		preheaderChannels: 'حساب صانع المحتوى الخاص بك جاهز مع {channels}. اقبل الدعوة لتسجيل الدخول.',
		greeting: 'السلام عليكم {name}،',
		greetingNoName: 'السلام عليكم،',
		account: 'أنشأ لك أحد مشرفي الأمة الآن حساب صانع محتوى.',
		createdOne: 'ويضم القناة {channels} جاهزةً لتديرها.',
		createdMany: 'ويضم القنوات {channels} جاهزةً لتديرها.',
		transferredOne: 'ونُقلت إليه القناة {channels}.',
		transferredMany: 'ونُقلت إليه القنوات {channels}.',
		how: 'اقبل الدعوة لتسجيل الدخول باسم {email}. لا تحتاج إلى كلمة مرور: يسجّل الزر دخولك، ويمكنك بعدها مباشرة إضافة مفتاح مرور (بصمة الوجه أو الإصبع).',
		button: 'قبول الدعوة',
		videoIntro: 'وشارك معك هذا المرئي:',
		videoAlt: 'شغّل «{title}» على الأمة الآن',
		noteLabel: 'ملاحظة من المشرف',
		expires: 'يعمل هذا الرابط مرة واحدة حتى {expires}. إن انتهت صلاحيته أو استُخدم من قبل، فافتحه واطلب رابطًا جديدًا.',
		reason: 'وصلتك هذه الرسالة لأن أحد مشرفي الأمة الآن دعا هذا العنوان إلى حساب صانع محتوى. إن لم تكن تتوقعها، فيمكنك تجاهلها.',
	},
};

export type CopyFallbackReason = 'missing' | 'invalid' | 'locale_mismatch';

/**
 * The admin's copy from a create/resend request, when it is usable for this locale: the creator
 * invite, the same language, every field a non-empty string. Otherwise why not.
 */
export function parseInviteCopy(raw: unknown, locale: InviteLocale): { copy: InviteCopy; version: number | null } | { reason: CopyFallbackReason } {
	if (raw === undefined || raw === null) return { reason: 'missing' };
	const r = raw as { key?: unknown; locale?: unknown; version?: unknown; copy?: unknown };
	if (typeof raw !== 'object' || r.key !== 'creator_invite' || !r.copy || typeof r.copy !== 'object') return { reason: 'invalid' };
	if (r.locale !== locale) return { reason: 'locale_mismatch' };
	const src = r.copy as Record<string, unknown>;
	const copy = {} as InviteCopy;
	for (const field of INVITE_COPY_FIELDS) {
		const v = src[field];
		if (typeof v !== 'string' || !v.trim() || v.length > 2000) return { reason: 'invalid' };
		copy[field] = v;
	}
	return { copy, version: typeof r.version === 'number' ? r.version : null };
}

const TOKEN = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Fills {name}-style placeholders in one pass; a value that looks like a placeholder is never filled again. */
export function fillPlaceholders(text: string, values: Record<string, string>): string {
	return text.replace(TOKEN, (whole, name: string) => (Object.prototype.hasOwnProperty.call(values, name) ? values[name]! : whole));
}

export function inviteEmailDoc(data: InviteEmailData, copy: InviteCopy = BUILT_IN_COPY[data.locale === 'ar' ? 'ar' : 'en']): EmailDoc {
	const locale: InviteLocale = data.locale === 'ar' ? 'ar' : 'en';
	const channels = data.channels ?? [];
	const video = data.video ? inviteVideo(data.video) : null;
	const moved = channels.filter((c) => c.action === 'transferred').map((c) => c.name);
	const made = channels.filter((c) => c.action !== 'transferred').map((c) => c.name);
	const all = channels.length ? joinNames(channels.map((c) => c.name), locale) : '';
	const base = { name: data.name ?? '', email: data.email, channels: all, expires: formatEmailDate(data.expiresAt, locale) };
	const fill = (field: InviteCopyField, channelsText = all) => fillPlaceholders(copy[field], { ...base, channels: channelsText });
	const intro = [
		fill('account'),
		made.length ? fill(made.length > 1 ? 'createdMany' : 'createdOne', joinNames(made, locale)) : '',
		moved.length ? fill(moved.length > 1 ? 'transferredMany' : 'transferredOne', joinNames(moved, locale)) : '',
	]
		.filter(Boolean)
		.join(' ');
	return {
		locale,
		subject: fill('subject'),
		preheader: all ? fill('preheaderChannels') : fill('preheader'),
		greeting: data.name ? fill('greeting') : fill('greetingNoName'),
		blocks: [
			{ kind: 'p', text: intro },
			...(video
				? [
						{ kind: 'p' as const, text: fill('videoIntro') },
						{ kind: 'video' as const, url: video.urls[locale], imageUrl: video.imageUrl, title: video.title, channel: video.channel, alt: fillPlaceholders(copy.videoAlt, { title: video.title }) },
					]
				: []),
			{ kind: 'p', text: fill('how') },
		],
		cta: { label: fill('button'), url: data.link },
		after: [
			...(data.note ? [{ kind: 'quote' as const, label: fill('noteLabel'), text: data.note }] : []),
			{ kind: 'small', text: fill('expires') },
		],
		reason: fill('reason'),
	};
}

export function renderInviteEmail(data: InviteEmailData, copy?: InviteCopy): RenderedEmailParts {
	return renderEmail(inviteEmailDoc(data, copy));
}

/** The built-in subject (emergency default; the admin's copy sets the real one). */
export const inviteEmailSubject = (locale: InviteLocale): string => BUILT_IN_COPY[locale === 'ar' ? 'ar' : 'en'].subject;
export const inviteEmailHtml = (data: InviteEmailData): string => renderInviteEmail(data).html;
export const inviteEmailText = (data: InviteEmailData): string => renderInviteEmail(data).text;

/**
 * "Email me a sign-in link" on the sign-in page (docs/USER_INVITES.md "No sign-in method yet"): an
 * account with no password and no passkey gets the same single-use invite link, in its own short
 * email (not the admin's invite wording: the person asked to sign in, nobody invited them again).
 */
export const SIGN_IN_LINK_COPY: Record<InviteLocale, { subject: string; preheader: string; greeting: string; text: string; button: string; expires: string; reason: string }> = {
	en: {
		subject: 'Your sign-in link for Al Ummah Now',
		preheader: 'Open it to sign in. It works once.',
		greeting: 'Assalamu alaikum,',
		text: 'You asked to sign in to Al Ummah Now as {email}. Your account has no password or passkey yet, so this link signs you in.',
		button: 'Sign in',
		expires: 'This link works once, until {expires}. After you sign in, you can add a passkey or a password.',
		reason: "You got this email because someone asked for a sign-in link for this address on the Al Ummah Now sign-in page. If it wasn't you, you can ignore it: nothing changes without the link.",
	},
	ar: {
		subject: 'رابط تسجيل الدخول إلى الأمة الآن',
		preheader: 'افتحه لتسجيل الدخول. يعمل مرة واحدة.',
		greeting: 'السلام عليكم،',
		text: 'طلبت تسجيل الدخول إلى الأمة الآن باسم {email}. ليس لحسابك كلمة مرور ولا مفتاح مرور بعد، لذا يسجّل هذا الرابط دخولك.',
		button: 'تسجيل الدخول',
		expires: 'يعمل هذا الرابط مرة واحدة حتى {expires}. بعد تسجيل الدخول يمكنك إضافة مفتاح مرور أو كلمة مرور.',
		reason: 'وصلتك هذه الرسالة لأن أحدهم طلب رابط تسجيل دخول لهذا العنوان من صفحة تسجيل الدخول في الأمة الآن. إن لم تكن أنت، فيمكنك تجاهلها: لا يتغيّر شيء دون الرابط.',
	},
};

export function signInLinkEmailDoc(data: Pick<InviteEmailData, 'email' | 'link' | 'expiresAt' | 'locale'>): EmailDoc {
	const locale: InviteLocale = data.locale === 'ar' ? 'ar' : 'en';
	const c = SIGN_IN_LINK_COPY[locale];
	const values = { email: data.email, expires: formatEmailDate(data.expiresAt, locale) };
	return {
		locale,
		subject: c.subject,
		preheader: c.preheader,
		greeting: c.greeting,
		blocks: [{ kind: 'p', text: fillPlaceholders(c.text, values) }],
		cta: { label: c.button, url: data.link },
		after: [{ kind: 'small', text: fillPlaceholders(c.expires, values) }],
		reason: c.reason,
	};
}

export function renderSignInLinkEmail(data: Pick<InviteEmailData, 'email' | 'link' | 'expiresAt' | 'locale'>): RenderedEmailParts {
	return renderEmail(signInLinkEmailDoc(data));
}
