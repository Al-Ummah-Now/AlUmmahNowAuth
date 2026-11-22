/**
 * The invite link's pages (GET /invite/:token) in the sign-in look, in the
 * page's language: `?lang=` if given, else the invite's language (English for
 * an unknown link). A GET never spends the token (mail scanners open links).
 *
 * - ready: "Your account is ready" + Continue (POST: signs in, no password).
 * - signed-in: this browser is already signed in as the invited account.
 * - setup: the link was used or expired but the account has no way to sign in
 *   yet (no password, no passkey): "Finish setting up your account" + a button
 *   that emails a fresh single-use link. Never "sign in".
 * - sent / cooldown: after that button.
 * - active: the account is set up: "You're already set up" + Sign in.
 * - withdrawn: the invite was revoked (or the account removed): contact the team.
 * - unknown: a link we don't know (replaced by a newer email, or removed).
 * - busy: too many tries from this network.
 *
 * Everything is in the page: no browser dialogs. Forms carry the CSRF token
 * that matches the `invite_csrf` cookie set with the page.
 */
import { html, raw } from 'hono/html';
import { Layout } from '@al-ummah-now/openauth/ui/base';
import type { Theme } from '@al-ummah-now/openauth/ui/theme';

export type Locale = 'en' | 'ar';

const COPY = {
	en: {
		readyTitle: 'Your account is ready',
		ready: (email: string) => `An Al Ummah Now admin set up an account for ${email}, with everything ready for you.`,
		readyHow: 'Continue to sign in. You don’t need a password: this link from your inbox is enough.',
		continue: 'Continue',
		signedInTitle: 'You’re signed in',
		signedIn: (email: string) => `This browser is already signed in as ${email}.`,
		setupTitle: 'Finish setting up your account',
		setupUsed: (email: string) => `This link has already been used, and your account ${email} isn’t set up yet: we can email you a new link to finish setting it up.`,
		setupExpired: (email: string) => `This link has expired. Your account ${email} is waiting for you: we can email you a new link to finish setting it up.`,
		supersededEmail: 'A newer invite email replaced this link. We can email a new link to the address the invite was sent to.',
		supersededLink: 'A newer link to this invite replaced this one. We can email a new link to the address the invite was sent to.',
		send: 'Email me a new link',
		sentTitle: 'Check your inbox',
		sent: (email: string) => `We sent a new link to ${email}. It works once. Open it to finish setting up your account.`,
		sentToInvite: 'We sent a new link to the address the invite was sent to. It works once. Open it to finish setting up your account.',
		cooldownTitle: 'We just sent you a link',
		cooldown: (email: string) => `Check the inbox of ${email}, including the spam folder. You can ask for another link in a few minutes.`,
		cooldownToInvite: 'Check the inbox the invite was sent to, including the spam folder. You can ask for another link in a few minutes.',
		sendFailedTitle: 'We couldn’t send the email',
		sendFailed: 'Something went wrong while sending the link. Try again in a minute.',
		tryAgain: 'Try again',
		activeTitle: 'You’re already set up',
		active: (email: string) => `This link has already been used. Your account ${email} is ready: sign in to continue.`,
		signIn: 'Sign in',
		withdrawnTitle: 'This invite was withdrawn',
		withdrawn: 'The invite this link belongs to is no longer available. If you think this is a mistake, contact the person who invited you or the Al Ummah Now team.',
		unknownTitle: 'We can’t use this link',
		unknown: 'This link may have been used already, or the invite may have been withdrawn. If your account is set up, sign in. If it isn’t, enter the email address the invite was sent to and we’ll email you a new link.',
		emailLabel: 'Email address',
		invalidEmail: 'Enter a valid email address.',
		requested: 'If an invite is waiting for that address, we’ve emailed it a new link. It works once. If nothing arrives in a few minutes, contact the person who invited you or the Al Ummah Now team.',
		home: 'Go to Al Ummah Now',
		busyTitle: 'Too many tries',
		busy: 'Wait a minute, then open the link again.',
		passkeyTitle: 'Sign in faster next time',
		passkeyText: 'Add a passkey to sign in with Face ID, your fingerprint or your device’s screen lock. No password to remember.',
		skip: 'Skip',
	},
	ar: {
		readyTitle: 'حسابك جاهز',
		ready: (email: string) => `أعدّ أحد مشرفي الأمة الآن حسابًا للبريد ${email}، وكل شيء جاهز لك.`,
		readyHow: 'تابع لتسجيل الدخول. لا تحتاج إلى كلمة مرور: يكفي هذا الرابط الذي وصلك في بريدك.',
		continue: 'متابعة',
		signedInTitle: 'أنت مسجّل الدخول',
		signedIn: (email: string) => `هذا المتصفح مسجّل الدخول بالفعل باسم ${email}.`,
		setupTitle: 'أكمِل إعداد حسابك',
		setupUsed: (email: string) => `استُخدم هذا الرابط من قبل، ولم يكتمل إعداد حسابك ${email} بعد: يمكننا أن نرسل إليك رابطًا جديدًا لإكمال إعداده.`,
		setupExpired: (email: string) => `انتهت صلاحية هذا الرابط. حسابك ${email} بانتظارك: يمكننا أن نرسل إليك رابطًا جديدًا لإكمال إعداده.`,
		supersededEmail: 'حلّت محلّ هذا الرابط رسالة دعوة أحدث. يمكننا أن نرسل رابطًا جديدًا إلى البريد الذي أُرسلت إليه الدعوة.',
		supersededLink: 'حلّ محلّ هذا الرابط رابط أحدث للدعوة نفسها. يمكننا أن نرسل رابطًا جديدًا إلى البريد الذي أُرسلت إليه الدعوة.',
		send: 'أرسل لي رابطًا جديدًا',
		sentTitle: 'تحقّق من بريدك',
		sent: (email: string) => `أرسلنا رابطًا جديدًا إلى ${email}. يعمل مرة واحدة. افتحه لإكمال إعداد حسابك.`,
		sentToInvite: 'أرسلنا رابطًا جديدًا إلى البريد الذي أُرسلت إليه الدعوة. يعمل مرة واحدة. افتحه لإكمال إعداد حسابك.',
		cooldownTitle: 'أرسلنا إليك رابطًا للتو',
		cooldown: (email: string) => `تحقّق من بريد ${email}، بما في ذلك مجلد الرسائل غير المرغوب فيها. يمكنك طلب رابط آخر بعد بضع دقائق.`,
		cooldownToInvite: 'تحقّق من البريد الذي أُرسلت إليه الدعوة، بما في ذلك مجلد الرسائل غير المرغوب فيها. يمكنك طلب رابط آخر بعد بضع دقائق.',
		sendFailedTitle: 'تعذّر إرسال الرسالة',
		sendFailed: 'حدث خطأ أثناء إرسال الرابط. حاول مرة أخرى بعد دقيقة.',
		tryAgain: 'حاول مرة أخرى',
		activeTitle: 'حسابك مُعدّ بالفعل',
		active: (email: string) => `استُخدم هذا الرابط من قبل. حسابك ${email} جاهز: سجّل الدخول للمتابعة.`,
		signIn: 'تسجيل الدخول',
		withdrawnTitle: 'سُحبت هذه الدعوة',
		withdrawn: 'لم تعد الدعوة التي يتبع لها هذا الرابط متاحة. إن كنت ترى أن هذا خطأ، فتواصل مع من دعاك أو مع فريق الأمة الآن.',
		unknownTitle: 'لا يمكننا استخدام هذا الرابط',
		unknown: 'ربما استُخدم هذا الرابط من قبل، أو سُحبت الدعوة. إن كان حسابك مُعدًّا فسجّل الدخول، وإلا فأدخل البريد الذي أُرسلت إليه الدعوة وسنرسل إليك رابطًا جديدًا.',
		emailLabel: 'البريد الإلكتروني',
		invalidEmail: 'أدخل بريدًا إلكترونيًا صحيحًا.',
		requested: 'إن كانت هناك دعوة بانتظار هذا البريد، فقد أرسلنا إليه رابطًا جديدًا. يعمل مرة واحدة. إن لم يصلك شيء خلال دقائق، فتواصل مع من دعاك أو مع فريق الأمة الآن.',
		home: 'الانتقال إلى الأمة الآن',
		busyTitle: 'محاولات كثيرة',
		busy: 'انتظر دقيقة ثم افتح الرابط مرة أخرى.',
		passkeyTitle: 'سجّل الدخول أسرع في المرة القادمة',
		passkeyText: 'أضف مفتاح مرور لتسجيل الدخول ببصمة الوجه أو بصمة الإصبع أو قفل شاشة جهازك. لا كلمة مرور تحفظها.',
		skip: 'تجاوز',
	},
} as const;

export function inviteCopy(lang: Locale) {
	return COPY[lang];
}

/** `?lang=ar|en` wins; else the invite's own language; else English. */
export const pageLocale = (url: URL, inviteLocale?: string | null): Locale => {
	const asked = url.searchParams.get('lang');
	if (asked === 'ar' || asked === 'en') return asked;
	return inviteLocale === 'ar' ? 'ar' : 'en';
};

const STYLE = `
[data-page^="invite"] { display:flex; flex-direction:column; gap:1rem; }
/* The card's heading: same size and weight as the passkey card's and the link-sent page's */
[data-page^="invite"] [data-component="title"] { font-size:1.25rem; font-weight:600; line-height:1.4; margin:0; }
[data-page^="invite"] [data-slot="actions"] { display:flex; flex-direction:column; gap:.75rem; }
[data-page^="invite"] [data-component="button"] { width:100%; text-decoration:none; text-align:center; }
/* Secondary actions: an outline that stays visible on the dark card, never a second filled button */
[data-page^="invite"] [data-component="button"][data-color="ghost"] { background:transparent; color:inherit; border:1px solid color-mix(in srgb, currentColor 55%, transparent); box-shadow:none; }
[data-page^="invite"] [data-slot="field"] { display:flex; flex-direction:column; gap:.5rem; font-size:var(--font-size-sm); }
/* Same look as the sign-in pages' form-alert; the field it describes is outlined in the same colour */
[data-page^="invite"] [data-slot="error"] { color:var(--color-error); background:var(--color-background-error); border-radius:calc(var(--border-radius) * 0.25rem); padding:.625rem 1rem; font-size:var(--font-size-sm); margin:0; }
[data-page^="invite"] [data-component="input"][aria-invalid="true"] { border-color:var(--color-error); box-shadow:0 0 0 1px var(--color-error); }
[data-page^="invite"] [data-slot="addr"] { display:inline-block; max-width:100%; overflow-wrap:anywhere; }
`;

export interface PageOptions {
	theme?: Theme;
	status?: number;
	/** Set-Cookie headers to add (the CSRF cookie) */
	cookies?: string[];
}

async function respond(body: ReturnType<typeof html>, lang: Locale, opts: PageOptions): Promise<Response> {
	const page = Layout({ theme: opts.theme, locale: lang, children: html`<style>${raw(STYLE)}</style>${body}` });
	const headers = new Headers({
		'Content-Type': 'text/html; charset=utf-8',
		'Content-Language': lang,
		'Cache-Control': 'no-store',
		'Referrer-Policy': 'no-referrer',
		'X-Robots-Tag': 'noindex',
	});
	for (const cookie of opts.cookies ?? []) headers.append('Set-Cookie', cookie);
	return new Response(`<!DOCTYPE html>${await page.toString()}`, { status: opts.status ?? 200, headers });
}

// An email in running text: isolated so an address reads correctly inside Arabic. Punctuation
// right after it stays with it ([data-slot="addr"] keeps together), so a wrapped address never
// leaves a comma alone at the start of the next line.
const addr = (email: string, after: string) => html`<span data-slot="addr"><bdi dir="ltr">${email}</bdi>${after}</span>`;

function textWith(template: string, values: Record<string, string>) {
	// Splits the translated sentence around its email placeholders (with any punctuation after them)
	const parts = template.split(/(\uE000[a-z]+\uE000[،,.:;؛]?)/);
	return parts.map((part) => {
		const m = /^\uE000([a-z]+)\uE000([،,.:;؛]?)$/.exec(part);
		return m ? addr(values[m[1]] ?? '', m[2]) : part;
	});
}
const P = (k: string) => `\uE000${k}\uE000`;

export type InvitePageState =
	| { kind: 'ready'; email: string; action: string; csrf: string }
	| { kind: 'signed-in'; email: string; continueUrl: string }
	| { kind: 'setup'; email: string; why: 'used' | 'expired'; action: string; csrf: string }
	// A newer email or link replaced this one: the address is never shown (the link may have been passed on)
	| { kind: 'superseded'; reason: 'email' | 'link'; action: string; csrf: string }
	// email: shown when the person proved the inbox (their own link); absent after a replaced link
	| { kind: 'sent'; email?: string }
	| { kind: 'cooldown'; email?: string }
	| { kind: 'send-failed'; email?: string; action: string; csrf: string }
	| { kind: 'active'; email: string; signInUrl: string }
	| { kind: 'withdrawn'; homeUrl: string }
	// A link we can't match to any invite (also links used before their hash was kept): sign in, or ask by address
	| { kind: 'unknown'; signInUrl: string; action: string; csrf: string; invalidEmail?: boolean; email?: string }
	| { kind: 'requested'; signInUrl: string }
	| { kind: 'busy' };

const csrfField = (csrf: string) => html`<input type="hidden" name="csrf" value="${csrf}" />`;

/** One page per state; hono/html escapes every interpolated value. */
export function renderInviteState(lang: Locale, state: InvitePageState, opts: PageOptions = {}): Promise<Response> {
	const t = COPY[lang];
	let body: ReturnType<typeof html>;
	switch (state.kind) {
		case 'ready':
			body = html`<form data-component="form" data-page="invite" data-state="ready" method="post" action="${state.action}">
				<h1 data-component="title">${t.readyTitle}</h1>
				<p data-component="description">${textWith(t.ready(P('email')), { email: state.email })}</p>
				<p data-component="description">${t.readyHow}</p>
				${csrfField(state.csrf)}
				<div data-slot="actions"><button data-component="button" type="submit" data-action="accept-invite">${t.continue}</button></div>
			</form>`;
			break;
		case 'signed-in':
			body = html`<div data-component="form" data-page="invite" data-state="signed-in">
				<h1 data-component="title">${t.signedInTitle}</h1>
				<p data-component="description">${textWith(t.signedIn(P('email')), { email: state.email })}</p>
				<div data-slot="actions"><a data-component="button" href="${state.continueUrl}" data-action="continue">${t.continue}</a></div>
			</div>`;
			break;
		case 'setup':
		case 'superseded':
		case 'send-failed': {
			const failed = state.kind === 'send-failed';
			const text =
				state.kind === 'send-failed'
					? t.sendFailed
					: state.kind === 'superseded'
						? state.reason === 'link'
							? t.supersededLink
							: t.supersededEmail
						: textWith((state.why === 'used' ? t.setupUsed : t.setupExpired)(P('email')), { email: state.email });
			const reason = state.kind === 'setup' ? state.why : state.kind === 'superseded' ? `superseded-${state.reason}` : 'failed';
			body = html`<form data-component="form" data-page="invite" data-state="${state.kind}" data-reason="${reason}" method="post" action="${state.action}">
				<h1 data-component="title">${failed ? t.sendFailedTitle : t.setupTitle}</h1>
				<p data-component="description" ${failed ? html`role="alert"` : ''}>${text}</p>
				${csrfField(state.csrf)}
				<div data-slot="actions"><button data-component="button" type="submit" data-action="send-setup-link">${failed ? t.tryAgain : t.send}</button></div>
			</form>`;
			break;
		}
		case 'sent':
		case 'cooldown': {
			const sent = state.kind === 'sent';
			body = html`<div data-component="form" data-page="invite" data-state="${state.kind}" role="status">
				<h1 data-component="title">${sent ? t.sentTitle : t.cooldownTitle}</h1>
				<p data-component="description">${
					state.email === undefined
						? sent
							? t.sentToInvite
							: t.cooldownToInvite
						: textWith(sent ? t.sent(P('email')) : t.cooldown(P('email')), { email: state.email })
				}</p>
			</div>`;
			break;
		}
		case 'active':
			body = html`<div data-component="form" data-page="invite" data-state="active">
				<h1 data-component="title">${t.activeTitle}</h1>
				<p data-component="description">${textWith(t.active(P('email')), { email: state.email })}</p>
				<div data-slot="actions"><a data-component="button" href="${state.signInUrl}" data-action="sign-in">${t.signIn}</a></div>
			</div>`;
			break;
		case 'withdrawn':
			body = html`<div data-component="form" data-page="invite" data-state="withdrawn" role="status">
				<h1 data-component="title">${t.withdrawnTitle}</h1>
				<p data-component="description">${t.withdrawn}</p>
				<a data-component="button" data-color="ghost" href="${state.homeUrl}" data-action="home">${t.home}</a>
			</div>`;
			break;
		case 'unknown':
			body = html`<form data-component="form" data-page="invite" data-state="unknown" method="post" action="${state.action}" novalidate>
				<h1 data-component="title">${t.unknownTitle}</h1>
				<p data-component="description">${t.unknown}</p>
				<label data-slot="field">
					<span>${t.emailLabel}</span>
					<input data-component="input" type="email" name="email" autocomplete="email" inputmode="email" dir="ltr" required
						value="${state.email ?? ''}" ${state.invalidEmail ? html`aria-invalid="true" aria-describedby="invite-email-error"` : ''} />
				</label>
				${state.invalidEmail ? html`<p id="invite-email-error" data-slot="error" role="alert">${t.invalidEmail}</p>` : ''}
				${csrfField(state.csrf)}
				<div data-slot="actions">
					<button data-component="button" type="submit" data-action="request-link">${t.send}</button>
					<a data-component="button" data-color="ghost" href="${state.signInUrl}" data-action="sign-in">${t.signIn}</a>
				</div>
			</form>`;
			break;
		case 'requested':
			body = html`<div data-component="form" data-page="invite" data-state="requested" role="status">
				<h1 data-component="title">${t.sentTitle}</h1>
				<p data-component="description">${t.requested}</p>
				<a data-component="button" data-color="ghost" href="${state.signInUrl}" data-action="sign-in">${t.signIn}</a>
			</div>`;
			break;
		case 'busy':
			body = html`<div data-component="form" data-page="invite" data-state="busy" role="alert">
				<h1 data-component="title">${t.busyTitle}</h1>
				<p data-component="description">${t.busy}</p>
			</div>`;
			break;
	}
	return respond(body, lang, opts);
}
