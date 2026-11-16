/**
 * The invite email, in ONE language: the one the admin picked next to Send
 * (the invite's locale; a resend may change it). Sent with the same Resend
 * sender as email codes (src/email.ts), in the shared design (src/email/layout.ts).
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

const COPY = {
	en: {
		subject: "You're invited to Al Ummah Now",
		preheader: (channels: string | null) => (channels ? `Your creator account and ${channels} are ready. Accept the invite to sign in.` : 'Your creator account is ready. Accept the invite to sign in.'),
		greeting: (name: string | null) => (name ? `Assalamu alaikum ${name},` : 'Assalamu alaikum,'),
		account: 'An Al Ummah Now admin has set up a creator account for you.',
		created: (names: string, n: number) => `It comes with ${n > 1 ? 'the channels' : 'the channel'} ${names}, ready for you to manage.`,
		transferred: (names: string, n: number) => `${n > 1 ? 'The channels' : 'The channel'} ${names} ${n > 1 ? 'have' : 'has'} been moved to your account.`,
		how: (email: string) => `Accept the invite to sign in as ${email}. You don't need a password: the button signs you in, and you can add a passkey (Face ID or fingerprint) right after.`,
		button: 'Accept the invite',
		videoIntro: 'They also shared this video with you:',
		videoAlt: (title: string) => `Play "${title}" on Al Ummah Now`,
		note: 'Note from the admin',
		expires: (date: string) => `This link works once, until ${date}. If it has expired or was already used, open it anyway and ask for a new one.`,
		reason: 'You got this email because an Al Ummah Now admin invited this address to a creator account. If you weren\'t expecting it, you can ignore it.',
	},
	ar: {
		subject: 'دعوة للانضمام إلى الأمة الآن',
		preheader: (channels: string | null) => (channels ? `حساب صانع المحتوى الخاص بك جاهز مع ${channels}. اقبل الدعوة لتسجيل الدخول.` : 'حساب صانع المحتوى الخاص بك جاهز. اقبل الدعوة لتسجيل الدخول.'),
		greeting: (name: string | null) => (name ? `السلام عليكم ${name}،` : 'السلام عليكم،'),
		account: 'أنشأ لك أحد مشرفي الأمة الآن حساب صانع محتوى.',
		created: (names: string, n: number) => `ويضم ${n > 1 ? 'القنوات' : 'القناة'} ${names} جاهزةً لتديرها.`,
		transferred: (names: string, n: number) => `ونُقلت إليه ${n > 1 ? 'القنوات' : 'القناة'} ${names}.`,
		how: (email: string) => `اقبل الدعوة لتسجيل الدخول باسم ${email}. لا تحتاج إلى كلمة مرور: يسجّل الزر دخولك، ويمكنك بعدها مباشرة إضافة مفتاح مرور (بصمة الوجه أو الإصبع).`,
		button: 'قبول الدعوة',
		videoIntro: 'وشارك معك هذا المرئي:',
		videoAlt: (title: string) => `شغّل «${title}» على الأمة الآن`,
		note: 'ملاحظة من المشرف',
		expires: (date: string) => `يعمل هذا الرابط مرة واحدة حتى ${date}. إن انتهت صلاحيته أو استُخدم من قبل، فافتحه واطلب رابطًا جديدًا.`,
		reason: 'وصلتك هذه الرسالة لأن أحد مشرفي الأمة الآن دعا هذا العنوان إلى حساب صانع محتوى. إن لم تكن تتوقعها، فيمكنك تجاهلها.',
	},
} as const;

export function inviteEmailDoc(data: InviteEmailData): EmailDoc {
	const locale: InviteLocale = data.locale === 'ar' ? 'ar' : 'en';
	const t = COPY[locale];
	const channels = data.channels ?? [];
	const video = data.video ? inviteVideo(data.video) : null;
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
			...(video
				? [
						{ kind: 'p' as const, text: t.videoIntro },
						{ kind: 'video' as const, url: video.urls[locale], imageUrl: video.imageUrl, title: video.title, channel: video.channel, alt: t.videoAlt(video.title) },
					]
				: []),
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
