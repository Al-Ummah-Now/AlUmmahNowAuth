/**
 * The invite email: both languages in one message, the invite's language first.
 * Sent with the same Resend sender as sign-in codes (src/email.ts).
 */
import type { InviteLocale } from './service';

export interface InviteEmailData {
	email: string;
	name: string | null;
	link: string;
	expiresAt: number;
	note: string | null;
	locale: InviteLocale;
}

const escapeHtml = (value: string) =>
	value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

function dateIn(locale: InviteLocale, at: number): string {
	return new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en-GB', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(at));
}

const COPY = {
	en: {
		subject: "You're invited to Al Ummah Now",
		greeting: (name: string | null) => (name ? `Assalamu alaikum ${name},` : 'Assalamu alaikum,'),
		body: 'An Al Ummah Now admin has set up a creator account for you. Everything is ready: sign in and your channel is waiting.',
		how: (email: string) => `Sign in with ${email}. If you have not set a password yet, choose "Create account" and we will email you a code to confirm it is you.`,
		button: 'Accept the invite',
		expires: (date: string) => `This link works until ${date}. After that you can still sign in with this email address.`,
		note: 'Note from the admin:',
		ignore: "If you weren't expecting this, you can ignore this email.",
	},
	ar: {
		subject: 'دعوة للانضمام إلى الأمة الآن',
		greeting: (name: string | null) => (name ? `السلام عليكم ${name}،` : 'السلام عليكم،'),
		body: 'أنشأ لك أحد مشرفي الأمة الآن حساب صانع محتوى. كل شيء جاهز: سجّل الدخول وستجد قناتك بانتظارك.',
		how: (email: string) => `سجّل الدخول باستخدام ${email}. إن لم تكن قد عيّنت كلمة مرور بعد، فاختر «إنشاء حساب» وسنرسل إليك رمزًا للتأكد من أنك صاحب البريد.`,
		button: 'قبول الدعوة',
		expires: (date: string) => `يعمل هذا الرابط حتى ${date}. وبعد ذلك يمكنك تسجيل الدخول بهذا البريد الإلكتروني.`,
		note: 'ملاحظة من المشرف:',
		ignore: 'إن لم تكن تتوقع هذه الرسالة، فيمكنك تجاهلها.',
	},
} as const;

function section(locale: InviteLocale, data: InviteEmailData): string {
	const t = COPY[locale];
	const dir = locale === 'ar' ? 'rtl' : 'ltr';
	const link = escapeHtml(data.link);
	return `
  <div dir="${dir}" lang="${locale}" style="text-align:${locale === 'ar' ? 'right' : 'left'};padding:24px 28px;">
    <p style="margin:0 0 12px;font-size:16px;">${escapeHtml(t.greeting(data.name))}</p>
    <p style="margin:0 0 12px;font-size:15px;line-height:1.6;">${escapeHtml(t.body)}</p>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.6;">${escapeHtml(t.how(data.email))}</p>
    <p style="margin:0 0 20px;"><a href="${link}" style="display:inline-block;background:#047857;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;">${escapeHtml(t.button)}</a></p>
    ${data.note ? `<p style="margin:0 0 6px;font-size:14px;font-weight:600;">${escapeHtml(t.note)}</p><p style="margin:0 0 16px;font-size:14px;line-height:1.6;white-space:pre-line;">${escapeHtml(data.note)}</p>` : ''}
    <p style="margin:0 0 6px;font-size:13px;color:#555555;">${escapeHtml(t.expires(dateIn(locale, data.expiresAt)))}</p>
    <p style="margin:0;font-size:13px;color:#555555;">${escapeHtml(t.ignore)}</p>
  </div>`;
}

const order = (first: InviteLocale): InviteLocale[] => (first === 'ar' ? ['ar', 'en'] : ['en', 'ar']);

export function inviteEmailSubject(locale: InviteLocale): string {
	const [a, b] = order(locale);
	return `${COPY[a].subject} · ${COPY[b].subject}`;
}

export function inviteEmailHtml(data: InviteEmailData): string {
	const [first, second] = order(data.locale);
	return `<!DOCTYPE html>
<html lang="${first}">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${escapeHtml(COPY[first].subject)}</title></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:#333333;">
<div style="max-width:600px;margin:0 auto;background:#ffffff;">
  <div style="background:#047857;padding:28px 20px;text-align:center;"><h1 style="margin:0;color:#ffffff;font-size:22px;">Al Ummah Now · الأمة الآن</h1></div>
  ${section(first, data)}
  <hr style="border:none;border-top:1px solid #e5e5e5;margin:0 28px;">
  ${section(second, data)}
</div>
</body>
</html>`;
}

export function inviteEmailText(data: InviteEmailData): string {
	return order(data.locale)
		.map((locale) => {
			const t = COPY[locale];
			return [
				t.greeting(data.name),
				'',
				t.body,
				t.how(data.email),
				'',
				`${t.button}: ${data.link}`,
				...(data.note ? ['', t.note, data.note] : []),
				'',
				t.expires(dateIn(locale, data.expiresAt)),
				t.ignore,
			].join('\n');
		})
		.join('\n\n———\n\n');
}
