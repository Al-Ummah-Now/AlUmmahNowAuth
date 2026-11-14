/**
 * The add-a-passkey pages on the auth host (AUTH-PASSKEYS):
 *
 * - the after-sign-in card (PK1): "Sign in faster next time: add a passkey",
 *   Add a passkey / Not now (staff: Continue), shown before the app's redirect;
 * - `/passkeys/setup`: the target of "Add a passkey" in the account hub and on
 *   the apps' "Passkey needed" pages.
 *
 * Rendered in openauth's sign-in Layout with the request's theme, en/ar (RTL)
 * from `?lang=`, Light/Dark from the theme. No browser dialogs: every message
 * is in the page. Browsers without WebAuthn skip the card automatically.
 */
import { html, raw } from 'hono/html';
import { Layout } from '@al-ummah-now/openauth/ui/base';
import type { Theme } from '@al-ummah-now/openauth/ui/theme';
import { passkeyClientScript } from '@al-ummah-now/openauth/passkey';

export type PageLocale = 'en' | 'ar';

const COPY = {
	en: {
		cardTitle: 'Sign in faster next time',
		cardText: 'Sign in without a password, using a passkey saved on this device, in your password manager, on your phone or on a security key.',
		staffTitle: 'Your role needs a passkey',
		staffText: 'Staff sign in to the admin tools with a passkey. Add one now: it takes a few seconds.',
		staffGrace: (d: string) => `Until ${d} you can still use your password.`,
		setupTitle: 'Add a passkey',
		setupText: 'Sign in without a password, using a passkey saved on this device, in your password manager, on your phone or on a security key.',
		add: 'Add a passkey',
		notNow: 'Not now',
		continue: 'Continue',
		back: 'Back',
		codeIntro: (email: string) => `First confirm it is you: we will email a code to ${email}.`,
		sendCode: 'Email me a code',
		codeSent: 'We sent a code. Enter it below.',
		codeLabel: 'Code from the email',
		adding: 'Follow the steps from your browser or device…',
		added: 'Passkey added. Next time, choose "Sign in with a passkey".',
		unsupported: "This browser can't save passkeys. Try another browser or device.",
		failed: "The passkey wasn't added. Try again.",
		cancelled: 'Cancelled. You can try again.',
		exists: 'This device already has a passkey for your account.',
		limit: 'You already have 10 passkeys. Remove one in your account first.',
		wrongCode: 'That code is not right. Check the email and try again.',
		lockedCode: 'That code no longer works. Ask for a new one.',
		codeFailed: "We couldn't send the code. Try again in a minute.",
		stale: 'For your security, sign in again before adding a passkey.',
		signInAgain: 'Sign in again',
		signedOut: 'Sign in first, then add a passkey.',
		signIn: 'Sign in',
		ticketInvalid: 'This setup link has expired or was already used. Ask an admin for a new one.',
		ticketOtherAccount: 'This setup link is for another account. Sign in with the account it was sent to.',
	},
	ar: {
		cardTitle: 'سجّل الدخول أسرع في المرة القادمة',
		cardText: 'سجّل الدخول دون كلمة مرور، بمفتاح مرور محفوظ على هذا الجهاز أو في مدير كلمات المرور أو على هاتفك أو على مفتاح أمان.',
		staffTitle: 'يحتاج دورك إلى مفتاح مرور',
		staffText: 'يسجّل فريق العمل الدخول إلى أدوات الإدارة بمفتاح مرور. أضف مفتاحك الآن، فالأمر يستغرق ثواني.',
		staffGrace: (d: string) => `حتى ${d} يمكنك استخدام كلمة المرور.`,
		setupTitle: 'إضافة مفتاح مرور',
		setupText: 'سجّل الدخول دون كلمة مرور، بمفتاح مرور محفوظ على هذا الجهاز أو في مدير كلمات المرور أو على هاتفك أو على مفتاح أمان.',
		add: 'إضافة مفتاح مرور',
		notNow: 'ليس الآن',
		continue: 'متابعة',
		back: 'رجوع',
		codeIntro: (email: string) => `أكّد هويتك أولًا: سنرسل رمزًا إلى ${email}.`,
		sendCode: 'أرسل لي رمزًا',
		codeSent: 'أرسلنا رمزًا. أدخله أدناه.',
		codeLabel: 'الرمز من الرسالة',
		adding: 'اتبع الخطوات التي يعرضها متصفحك أو جهازك…',
		added: 'أُضيف مفتاح المرور. في المرة القادمة اختر «الدخول بمفتاح المرور».',
		unsupported: 'لا يستطيع هذا المتصفح حفظ مفاتيح المرور. جرّب متصفحًا أو جهازًا آخر.',
		failed: 'لم يُضَف مفتاح المرور. حاول مرة أخرى.',
		cancelled: 'أُلغي الطلب. يمكنك المحاولة مرة أخرى.',
		exists: 'لهذا الجهاز مفتاح مرور لحسابك بالفعل.',
		limit: 'لديك 10 مفاتيح مرور بالفعل. أزل واحدًا من حسابك أولًا.',
		wrongCode: 'الرمز غير صحيح. تحقق من الرسالة وحاول مرة أخرى.',
		lockedCode: 'لم يعد هذا الرمز صالحًا. اطلب رمزًا جديدًا.',
		codeFailed: 'تعذّر إرسال الرمز. حاول مرة أخرى بعد دقيقة.',
		stale: 'لحماية حسابك، سجّل الدخول مرة أخرى قبل إضافة مفتاح مرور.',
		signInAgain: 'تسجيل الدخول مرة أخرى',
		signedOut: 'سجّل الدخول أولًا، ثم أضف مفتاح مرور.',
		signIn: 'تسجيل الدخول',
		ticketInvalid: 'انتهت صلاحية رابط الإعداد هذا أو استُخدم من قبل. اطلب رابطًا جديدًا من أحد المشرفين.',
		ticketOtherAccount: 'رابط الإعداد هذا لحساب آخر. سجّل الدخول بالحساب الذي أُرسل إليه.',
	},
} as const;

export function copyFor(locale: PageLocale) {
	return COPY[locale];
}

export interface AddPasskeyPage {
	locale: PageLocale;
	theme?: Theme;
	/** card: after sign-in, before the app's redirect; setup: /passkeys/setup */
	mode: 'card' | 'setup';
	/** Staff wording (and, in the card, no 30-day snooze) */
	staff: boolean;
	/** epoch seconds: shown as "until <date> you can use your password" */
	graceUntil?: number;
	/** Staff adding a first passkey without a setup link: confirm with an emailed code */
	needsCode: boolean;
	email: string;
	/** Where Continue / Not now / Back goes */
	continueUrl: string;
	/** Admin setup link token, passed through to the register calls */
	ticket?: string;
	/** Lang query for the API calls (so emails are in the page's language) */
	lang: PageLocale;
}

function formatDate(epochSeconds: number, locale: PageLocale): string {
	return new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en-GB', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(epochSeconds * 1000));
}

const STYLE = `
[data-page="passkey"] { display:flex; flex-direction:column; gap:1rem; }
[data-page="passkey"] [hidden] { display:none !important; }
[data-page="passkey"] [data-slot="status"] { min-height:1.25rem; font-size:var(--font-size-sm); }
[data-page="passkey"] [data-slot="status"][data-tone="error"] { color:var(--color-error); }
[data-page="passkey"] [data-slot="actions"] { display:flex; flex-direction:column; gap:.75rem; }
[data-page="passkey"] [data-component="button"] { width:100%; text-decoration:none; }
[data-page="passkey"] label { display:flex; flex-direction:column; gap:.5rem; font-size:var(--font-size-sm); }
`;

/** The page's script: the code step, the registration ceremony, Not now. */
function pageScript(p: AddPasskeyPage, t: ReturnType<typeof copyFor>): string {
	const cfg = {
		mode: p.mode,
		staff: p.staff,
		needsCode: p.needsCode,
		continueUrl: p.continueUrl,
		ticket: p.ticket ?? null,
		q: `?lang=${p.lang}`,
		t: {
			adding: t.adding,
			added: t.added,
			unsupported: t.unsupported,
			failed: t.failed,
			cancelled: t.cancelled,
			exists: t.exists,
			limit: t.limit,
			wrong_code: t.wrongCode,
			locked_code: t.lockedCode,
			code_failed: t.codeFailed,
			stale_sign_in: t.stale,
			not_signed_in: t.signedOut,
			ticket_invalid: t.ticketInvalid,
			ticket_other_account: t.ticketOtherAccount,
			codeSent: t.codeSent,
		},
	};
	// JSON in a script: escape "<" so a value can never close the tag
	const json = JSON.stringify(cfg).replace(/</g, '\\u003c');
	return `${passkeyClientScript}
(function(){
var C=${json},pk=window.oaPasskey,root=document.querySelector('[data-page="passkey"]');
var status=root.querySelector('[data-slot="status"]'),addBtn=root.querySelector('[data-action="add"]'),skip=root.querySelector('[data-action="skip"]');
var codeBox=root.querySelector('[data-slot="code"]'),sendBtn=root.querySelector('[data-action="send-code"]'),codeInput=root.querySelector('input[name="code"]');
var done=root.querySelector('[data-action="done"]');
function say(msg,tone){status.textContent=msg||'';if(tone)status.setAttribute('data-tone',tone);else status.removeAttribute('data-tone');}
function go(){window.location.assign(C.continueUrl);}
function post(path,body){return fetch(path+C.q,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify(body||{})}).then(function(r){return r.json().catch(function(){return {};}).then(function(j){j.__status=r.status;return j;});});}
if(!pk||!pk.supported()){ if(C.mode==='card'&&!C.staff){go();return;} say(C.t.unsupported,'error'); if(addBtn)addBtn.hidden=true; if(codeBox)codeBox.hidden=true; }
if(skip)skip.addEventListener('click',function(){skip.disabled=true;if(C.mode==='card'&&!C.staff){post('/passkeys/prompt/dismiss').then(go,go);}else{go();}});
if(sendBtn)sendBtn.addEventListener('click',function(){sendBtn.disabled=true;post('/passkeys/email-code').then(function(j){sendBtn.disabled=false;if(j.sent){say(C.t.codeSent);codeInput.hidden=false;codeInput.parentNode.hidden=false;addBtn.hidden=false;codeInput.focus();}else{say(C.t[j.error]||C.t.code_failed,'error');}},function(){sendBtn.disabled=false;say(C.t.code_failed,'error');});});
if(addBtn)addBtn.addEventListener('click',function(){
 addBtn.disabled=true;say(C.t.adding);
 var body={};if(C.ticket)body.ticket=C.ticket;if(C.needsCode&&codeInput)body.code=codeInput.value.trim();
 post('/passkeys/register/options',body).then(function(j){
  if(!j.options){addBtn.disabled=false;say(C.t[j.error]||C.t.failed,'error');return;}
  return pk.create(j.options).then(function(cred){return post('/passkeys/register/verify',{credential:cred,token:j.token});}).then(function(v){
   if(v&&v.ok){say(C.t.added);addBtn.hidden=true;if(skip)skip.hidden=true;if(codeBox)codeBox.hidden=true;done.hidden=false;done.focus();}
   else{addBtn.disabled=false;say(C.t[v&&v.error]||C.t.failed,'error');}
  },function(e){addBtn.disabled=false;
   if(e&&e.name==='InvalidStateError')say(C.t.exists,'error');else if(e&&(e.name==='NotAllowedError'||e.name==='AbortError'))say(C.t.cancelled);else say(C.t.failed,'error');});
 },function(){addBtn.disabled=false;say(C.t.failed,'error');});
});
if(done)done.addEventListener('click',go);
})();`;
}

export async function renderAddPasskeyPage(p: AddPasskeyPage): Promise<Response> {
	const t = copyFor(p.locale);
	const title = p.mode === 'card' ? (p.staff ? t.staffTitle : t.cardTitle) : p.staff ? t.staffTitle : t.setupTitle;
	const text = p.mode === 'card' ? (p.staff ? t.staffText : t.cardText) : p.staff ? t.staffText : t.setupText;
	const skipLabel = p.mode === 'card' ? (p.staff ? t.continue : t.notNow) : t.back;
	const body = html`<style>
			${raw(STYLE)}
		</style>
		<div data-component="form" data-page="passkey" data-mode="${p.mode}" aria-live="polite">
			<h1 data-component="title">${title}</h1>
			<p data-component="description">${text}</p>
			${p.staff && p.graceUntil && p.graceUntil * 1000 > Date.now()
				? html`<p data-component="description">${t.staffGrace(formatDate(p.graceUntil, p.locale))}</p>`
				: ''}
			${p.needsCode
				? html`<div data-slot="code">
						<p data-component="description">${t.codeIntro(p.email)}</p>
						<button type="button" data-component="button" data-color="ghost" data-action="send-code">${t.sendCode}</button>
						<label hidden
							>${t.codeLabel}
							<input data-component="input" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" hidden
						/></label>
					</div>`
				: ''}
			<p data-slot="status" role="status"></p>
			<div data-slot="actions">
				<button type="button" data-component="button" data-action="add" ${p.needsCode ? raw('hidden') : ''}>${t.add}</button>
				<button type="button" data-component="button" data-action="done" hidden>${t.continue}</button>
				<button type="button" data-component="button" data-color="ghost" data-action="skip">${skipLabel}</button>
			</div>
		</div>
		<script>
			${raw(pageScript(p, t))}
		</script>`;
	const page = Layout({ theme: p.theme, locale: p.locale, children: body });
	return new Response(`<!DOCTYPE html>${await page.toString()}`, {
		status: 200,
		headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Language': p.locale, 'Cache-Control': 'no-store' },
	});
}

/** /passkeys/setup when it can't run: signed out, stale sign-in, bad link. */
export async function renderPasskeyNotice(opts: {
	locale: PageLocale;
	theme?: Theme;
	message: string;
	action?: { label: string; href: string };
	back?: string;
}): Promise<Response> {
	const t = copyFor(opts.locale);
	const body = html`<div data-component="form" data-page="passkey-notice" role="alert">
		<h1 data-component="title">${t.setupTitle}</h1>
		<p data-component="description">${opts.message}</p>
		${opts.action ? html`<a data-component="button" href="${opts.action.href}">${opts.action.label}</a>` : ''}
		${opts.back ? html`<a data-component="link" href="${opts.back}">${t.back}</a>` : ''}
	</div>`;
	const page = Layout({ theme: opts.theme, locale: opts.locale, children: body });
	return new Response(`<!DOCTYPE html>${await page.toString()}`, {
		status: 200,
		headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Language': opts.locale, 'Cache-Control': 'no-store' },
	});
}
