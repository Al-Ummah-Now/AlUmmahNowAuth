/**
 * The add-a-passkey pages on the auth host (AUTH-PASSKEYS):
 *
 * - the after-sign-in card (PK1): "Sign in faster next time: add a passkey",
 *   Add a passkey / Not now, shown before the app's redirect;
 * - `/passkeys/setup`: the target of "Add a passkey" in the account hub and on
 *   the apps' "Passkey needed" pages.
 *
 * Staff adding a first passkey without a setup link confirm by email first, so
 * the page is three numbered steps: 1 email me a code, 2 enter the code, 3 add
 * the passkey. Each step's main action is the filled accent button; once the
 * code is accepted the browser's passkey prompt (where a password manager such
 * as 1Password offers to save it) opens at once when the browser allows it,
 * else "Add a passkey" waits as the step's button. Skipping is a secondary
 * button that says what it does ("Not now, use my password until <date>"),
 * and staff past their deadline get no skip at all.
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
		steps: 'Steps',
		stepDone: '(done)',
		stepConfirm: 'Confirm it is you',
		stepConfirmText: (email: string) => `We will email a 6-digit code to ${email}.`,
		stepCode: 'Enter the code',
		stepCodeText: (email: string) => `We sent a code to ${email}. It works for 15 minutes.`,
		stepAdd: 'Add the passkey',
		saveHint: 'Your password manager or device will ask to save the passkey. Follow its steps.',
		add: 'Add a passkey',
		notNow: 'Not now',
		notNowUntil: (d: string) => `Not now, use my password until ${d}`,
		notNowPassword: 'Not now, keep using my password',
		continue: 'Continue',
		back: 'Back',
		sendCode: 'Email me a code',
		resendCode: 'Send a new code',
		codeResent: 'We sent a new code.',
		confirmCode: 'Confirm code',
		codeLabel: 'Code from the email',
		codeFormat: 'Enter the 6 digits from the email.',
		codeExpired: 'That took too long. Ask for a new code.',
		pressAdd: 'Code accepted. Select "Add a passkey" to save it.',
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
		steps: 'الخطوات',
		stepDone: '(تمّت)',
		stepConfirm: 'أكّد هويتك',
		stepConfirmText: (email: string) => `سنرسل رمزًا من 6 أرقام إلى ${email}.`,
		stepCode: 'أدخل الرمز',
		stepCodeText: (email: string) => `أرسلنا رمزًا إلى ${email}. يبقى صالحًا 15 دقيقة.`,
		stepAdd: 'أضف مفتاح المرور',
		saveHint: 'سيطلب منك مدير كلمات المرور أو جهازك حفظ مفتاح المرور. اتبع الخطوات التي يعرضها.',
		add: 'إضافة مفتاح مرور',
		notNow: 'ليس الآن',
		notNowUntil: (d: string) => `ليس الآن، سأستخدم كلمة المرور حتى ${d}`,
		notNowPassword: 'ليس الآن، سأواصل استخدام كلمة المرور',
		continue: 'متابعة',
		back: 'رجوع',
		sendCode: 'أرسل لي رمزًا',
		resendCode: 'أرسل رمزًا جديدًا',
		codeResent: 'أرسلنا رمزًا جديدًا.',
		confirmCode: 'تأكيد الرمز',
		codeLabel: 'الرمز من الرسالة',
		codeFormat: 'أدخل الأرقام الستة من الرسالة.',
		codeExpired: 'انتهت المهلة. اطلب رمزًا جديدًا.',
		pressAdd: 'قُبل الرمز. اختر «إضافة مفتاح مرور» لحفظه.',
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
	/** Tests only: the clock for the grace check (ms) */
	now?: number;
}

function formatDate(epochSeconds: number, locale: PageLocale): string {
	return new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en-GB', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(epochSeconds * 1000));
}

/**
 * The skip button's label, or null when there is none.
 *
 * - /passkeys/setup: Back (the user came here from the hub or an app).
 * - Card, members: Not now (30-day snooze).
 * - Card, staff: says what skipping means. In the grace period: "Not now, use
 *   my password until <date>"; enforcement off: "Not now, keep using my
 *   password"; past the deadline: no skip (the admin tools refuse a password
 *   sign-in anyway).
 */
export function skipLabel(p: Pick<AddPasskeyPage, 'mode' | 'staff' | 'graceUntil' | 'locale' | 'now'>): string | null {
	const t = copyFor(p.locale);
	if (p.mode === 'setup') return t.back;
	if (!p.staff) return t.notNow;
	if (p.graceUntil === undefined) return t.notNowPassword;
	return p.graceUntil * 1000 > (p.now ?? Date.now()) ? t.notNowUntil(formatDate(p.graceUntil, p.locale)) : null;
}

/*
 * Theme-neutral on purpose: every theme styles [data-component="button"] (the
 * filled accent button) and the card's text colour; the rest here derives from
 * those (currentColor, --color-primary), so each theme keeps its own look.
 */
/*
 * The step number on the accent: black or white, whichever reads better.
 * openauth's buttons switch at OKLCH lightness 0.714, which puts white on
 * mid-tone accents (classic's #d4930d: 2.6:1); 0.6 is near where black and
 * white tie, so every built-in accent gets at least 4.5:1.
 */
const STYLE = `
[data-page="passkey"] { display:flex; flex-direction:column; gap:1rem; }
[data-page="passkey"] [hidden] { display:none !important; }
[data-page="passkey"] [data-component="title"] { margin:0; }
[data-page="passkey"] [data-component="description"] { margin:0; }
[data-page="passkey"] [data-slot="status"] { margin:0; font-size:var(--font-size-sm); line-height:1.5; }
[data-page="passkey"] [data-slot="status"]:empty { display:none; }
[data-page="passkey"] [data-slot="status"][data-tone="error"] { color:var(--color-error); }
[data-page="passkey"] [data-component="button"] { width:100%; min-height:2.75rem; height:auto; padding:.625rem 1rem; line-height:1.3; text-align:center; text-decoration:none; white-space:normal; }
[data-page="passkey"] [data-component="button"]:disabled { cursor:progress; opacity:.75; }
[data-page="passkey"] [data-component="button"]:focus-visible { outline:2px solid var(--color-high); outline-offset:3px; }
[data-page="passkey"] [data-component="button"][data-color="ghost"] { background:transparent; color:inherit; border:1px solid color-mix(in srgb, currentColor 55%, transparent); box-shadow:none; }
[data-page="passkey"] [data-component="button"][data-color="ghost"]:hover { background:color-mix(in srgb, currentColor 10%, transparent); }
[data-page="passkey"] [data-variant="link"] { align-self:flex-start; background:none; border:0; padding:.25rem 0; color:inherit; font:inherit; font-size:var(--font-size-sm); font-weight:500; text-decoration:underline; text-underline-offset:3px; cursor:pointer; }
[data-page="passkey"] [data-variant="link"]:focus-visible { outline:2px solid var(--color-high); outline-offset:2px; }
[data-page="passkey"] [data-slot="hint"] { margin:0; font-size:var(--font-size-sm); line-height:1.5; }

[data-page="passkey"] [data-slot="steps"] { list-style:none; margin:.25rem 0 0; padding:0; display:flex; flex-direction:column; }
[data-page="passkey"] [data-step] { position:relative; display:grid; grid-template-columns:2rem 1fr; column-gap:.875rem; padding-bottom:1.25rem; }
[data-page="passkey"] [data-step]:last-child { padding-bottom:0; }
/* The rail joining the step marks */
[data-page="passkey"] [data-step]:not(:last-child)::before { content:""; position:absolute; inset-inline-start:calc(1rem - 1px); top:2.25rem; bottom:.25rem; width:2px; border-radius:2px; background:color-mix(in srgb, currentColor 22%, transparent); }
[data-page="passkey"] [data-step][data-state="done"]:not(:last-child)::before { background:var(--color-primary); }
[data-page="passkey"] [data-slot="mark"] { grid-row:1 / span 2; width:2rem; height:2rem; border-radius:999px; display:flex; align-items:center; justify-content:center; font-weight:700; font-size:var(--font-size-sm); border:2px solid color-mix(in srgb, currentColor 45%, transparent); }
[data-page="passkey"] [data-step][data-state="current"] [data-slot="mark"],
[data-page="passkey"] [data-step][data-state="done"] [data-slot="mark"] { border-color:var(--color-primary); background:var(--color-primary); color:oklch(from var(--color-primary) clamp(0, calc((l - 0.6) * -1000), 1) 0 0); }
[data-page="passkey"] [data-step][data-state="current"] [data-slot="mark"] { box-shadow:0 0 0 4px color-mix(in srgb, var(--color-primary) 28%, transparent); }
[data-page="passkey"] [data-slot="mark"] svg { width:1rem; height:1rem; }
[data-page="passkey"] [data-slot="step-title"] { margin:0; min-height:2rem; display:flex; align-items:center; font-size:var(--font-size-md); font-weight:600; line-height:1.3; }
[data-page="passkey"] [data-step][data-state="todo"] [data-slot="step-title"] { font-weight:500; }
[data-page="passkey"] [data-slot="step-body"] { grid-column:2; display:flex; flex-direction:column; gap:.75rem; padding-top:.375rem; }
[data-page="passkey"] [data-step]:not([data-state="current"]) [data-slot="step-body"] { display:none; }
[data-page="passkey"] [data-slot="step-body"] p { margin:0; font-size:var(--font-size-sm); line-height:1.5; }
[data-page="passkey"] bdi { overflow-wrap:anywhere; }
[data-page="passkey"] [data-slot="code-form"] { display:flex; flex-direction:column; gap:.75rem; }
[data-page="passkey"] label { display:flex; flex-direction:column; gap:.375rem; font-size:var(--font-size-sm); font-weight:500; }
[data-page="passkey"] input[name="code"] { letter-spacing:.3em; font-size:var(--font-size-lg); text-align:center; direction:ltr; }
[data-page="passkey"] .visually-hidden { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
[data-page="passkey"] [data-slot="secondary"] { display:flex; flex-direction:column; gap:.75rem; padding-top:.25rem; }
`;

/** `text` with `email` kept left-to-right inside it (an address in Arabic copy). */
function withEmail(text: string, email: string) {
	const at = text.indexOf(email);
	if (at < 0) return text;
	return html`${text.slice(0, at)}<bdi dir="ltr">${email}</bdi>${text.slice(at + email.length)}`;
}

const CHECK = `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3 8.5l3.2 3L13 4.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/** The page's script: the code steps, the registration ceremony, the skip. */
function pageScript(p: AddPasskeyPage, t: ReturnType<typeof copyFor>): string {
	const cfg = {
		mode: p.mode,
		staff: p.staff,
		needsCode: p.needsCode,
		continueUrl: p.continueUrl,
		ticket: p.ticket ?? null,
		q: `?lang=${p.lang}`,
		check: CHECK,
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
			codeResent: t.codeResent,
			codeFormat: t.codeFormat,
			codeExpired: t.codeExpired,
			pressAdd: t.pressAdd,
		},
	};
	// JSON in a script: escape "<" so a value can never close the tag
	const json = JSON.stringify(cfg).replace(/</g, '\\u003c');
	// Held options are used before the registration token (5 min) runs out
	return `${passkeyClientScript}
(function(){
var C=${json},pk=window.oaPasskey,root=document.querySelector('[data-page="passkey"]');
function $(s){return root.querySelector(s);}
var status=$('[data-slot="status"]'),addBtn=$('[data-action="add"]'),skip=$('[data-action="skip"]'),done=$('[data-action="done"]');
var steps=$('[data-slot="steps"]'),sendBtn=$('[data-action="send-code"]'),resendBtn=$('[data-action="resend-code"]'),codeForm=$('[data-slot="code-form"]'),codeInput=$('input[name="code"]'),confirmBtn=$('[data-action="confirm-code"]');
var held=null,HOLD_MS=270000;
function say(msg,tone){status.textContent=msg||'';if(tone)status.setAttribute('data-tone',tone);else status.removeAttribute('data-tone');}
function go(){window.location.assign(C.continueUrl);}
function post(path,body){return fetch(path+C.q,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify(body||{})}).then(function(r){return r.json().catch(function(){return {};}).then(function(j){j.__status=r.status;return j;});});}
function setStep(n){root.setAttribute('data-current-step',String(n));if(!steps)return;
 [].forEach.call(steps.querySelectorAll('[data-step]'),function(li){var k=Number(li.getAttribute('data-step'));var st=k<n?'done':k===n?'current':'todo';li.setAttribute('data-state',st);
  if(st==='current')li.setAttribute('aria-current','step');else li.removeAttribute('aria-current');
  var mark=li.querySelector('[data-slot="mark"]');mark.innerHTML=st==='done'?C.check:String(k);li.querySelector('[data-slot="done-text"]').hidden=st!=='done';});
 placeStatus(steps.querySelector('[data-step="'+n+'"] [data-slot="step-body"]'));}
// Messages show under the current step's button (before "Send a new code"), else under the steps
function placeStatus(body){if(body&&!steps.hidden)body.insertBefore(status,body.querySelector('[data-variant="link"]'));else root.insertBefore(status,done);}
function finish(){say(C.t.added);setStep(4);if(addBtn)addBtn.hidden=true;if(skip)skip.hidden=true;done.hidden=false;done.focus();}
if(!pk||!pk.supported()){ if(C.mode==='card'&&!C.staff){go();return;} if(addBtn)addBtn.hidden=true; if(steps){steps.hidden=true;placeStatus(null);} say(C.t.unsupported,'error'); }
else if(steps)setStep(1);
if(skip)skip.addEventListener('click',function(){skip.disabled=true;if(C.mode==='card'&&!C.staff){post('/passkeys/prompt/dismiss').then(go,go);}else{go();}});
function sendCode(btn,again){btn.disabled=true;post('/passkeys/email-code').then(function(j){btn.disabled=false;
 if(j.sent){held=null;setStep(2);say(again?C.t.codeResent:'');codeInput.value='';codeInput.focus();}else{say(C.t[j.error]||C.t.code_failed,'error');}
},function(){btn.disabled=false;say(C.t.code_failed,'error');});}
if(sendBtn)sendBtn.addEventListener('click',function(){sendCode(sendBtn,false);});
if(resendBtn)resendBtn.addEventListener('click',function(){sendCode(resendBtn,true);});
// The ceremony: standard navigator.credentials.create (oaPasskey.create), so a
// password manager's extension (1Password and others) can offer to save it
function ceremony(auto){
 addBtn.disabled=true;say(C.t.adding);
 return pk.create(held.options).then(function(cred){return post('/passkeys/register/verify',{credential:cred,token:held.token});}).then(function(v){
  if(v&&v.ok){held=null;finish();return;}
  addBtn.disabled=false;say(C.t[v&&v.error]||C.t.failed,'error');
 },function(e){addBtn.disabled=false;
  if(e&&e.name==='InvalidStateError')say(C.t.exists,'error');
  else if(e&&(e.name==='NotAllowedError'||e.name==='AbortError'))say(auto?C.t.pressAdd:C.t.cancelled);
  else say(C.t.failed,'error');
  if(auto)addBtn.focus();
 });
}
function options(body){return post('/passkeys/register/options',body).then(function(j){if(!j.options){say(C.t[j.error]||C.t.failed,'error');return false;}held={options:j.options,token:j.token,at:Date.now()};return true;});}
function ticketBody(){var b={};if(C.ticket)b.ticket=C.ticket;return b;}
// The browser lets a page open the passkey prompt only shortly after a click or key press
function mayPromptNow(){var a=navigator.userActivation;return !a||a.isActive;}
if(codeForm)codeForm.addEventListener('submit',function(ev){ev.preventDefault();
 var code=codeInput.value.replace(/\\s+/g,'');
 if(!/^\\d{6}$/.test(code)){say(C.t.codeFormat,'error');codeInput.focus();return;}
 confirmBtn.disabled=true;say('');var body=ticketBody();body.code=code;
 options(body).then(function(ok){confirmBtn.disabled=false;if(!ok){codeInput.focus();return;}
  setStep(3);
  if(mayPromptNow())ceremony(true);else{say(C.t.pressAdd);addBtn.focus();}
 },function(){confirmBtn.disabled=false;say(C.t.failed,'error');});
});
if(addBtn)addBtn.addEventListener('click',function(){
 if(held&&Date.now()-held.at<HOLD_MS){ceremony(false);return;}
 held=null;
 if(C.needsCode){setStep(1);say(C.t.codeExpired,'error');return;}
 addBtn.disabled=true;say(C.t.adding);
 options(ticketBody()).then(function(ok){if(!ok){addBtn.disabled=false;return;}ceremony(false);},function(){addBtn.disabled=false;say(C.t.failed,'error');});
});
if(done)done.addEventListener('click',go);
})();`;
}

function step(n: number, title: string, body: unknown, t: ReturnType<typeof copyFor>, current: number) {
	const state = n < current ? 'done' : n === current ? 'current' : 'todo';
	return html`<li data-step="${n}" data-state="${state}" ${state === 'current' ? raw('aria-current="step"') : ''}>
		<span data-slot="mark" aria-hidden="true">${n}</span>
		<h2 data-slot="step-title">${title}<span data-slot="done-text" class="visually-hidden" hidden>&nbsp;${t.stepDone}</span></h2>
		<div data-slot="step-body">${body}</div>
	</li>`;
}

export async function renderAddPasskeyPage(p: AddPasskeyPage): Promise<Response> {
	const t = copyFor(p.locale);
	const title = p.mode === 'card' ? (p.staff ? t.staffTitle : t.cardTitle) : p.staff ? t.staffTitle : t.setupTitle;
	const text = p.mode === 'card' ? (p.staff ? t.staffText : t.cardText) : p.staff ? t.staffText : t.setupText;
	const skip = skipLabel(p);
	// The card's skip button carries the date; /passkeys/setup says it in a line
	const graceLine =
		p.mode === 'setup' && p.staff && p.graceUntil && p.graceUntil * 1000 > (p.now ?? Date.now())
			? html`<p data-component="description">${t.staffGrace(formatDate(p.graceUntil, p.locale))}</p>`
			: '';
	const addButton = html`<button type="button" data-component="button" data-action="add">${t.add}</button>`;
	const main = p.needsCode
		? html`<ol data-slot="steps" aria-label="${t.steps}">
				${step(
					1,
					t.stepConfirm,
					html`<p>${withEmail(t.stepConfirmText(p.email), p.email)}</p>
						<button type="button" data-component="button" data-action="send-code">${t.sendCode}</button>`,
					t,
					1
				)}
				${step(
					2,
					t.stepCode,
					html`<p>${withEmail(t.stepCodeText(p.email), p.email)}</p>
						<form data-slot="code-form" novalidate>
							<label
								>${t.codeLabel}
								<input data-component="input" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" dir="ltr"
							/></label>
							<button type="submit" data-component="button" data-action="confirm-code">${t.confirmCode}</button>
						</form>
						<button type="button" data-variant="link" data-action="resend-code">${t.resendCode}</button>`,
					t,
					1
				)}
				${step(3, t.stepAdd, html`<p>${t.saveHint}</p>${addButton}`, t, 1)}
			</ol>`
		: html`<p data-slot="hint">${t.saveHint}</p>
				${addButton}`;
	const body = html`<style>
			${raw(STYLE)}
		</style>
		<div data-component="form" data-page="passkey" data-mode="${p.mode}" data-current-step="${p.needsCode ? 1 : 3}">
			<h1 data-component="title">${title}</h1>
			<p data-component="description">${text}</p>
			${graceLine} ${main}
			<p data-slot="status" role="status" aria-live="polite"></p>
			<button type="button" data-component="button" data-action="done" hidden>${t.continue}</button>
			${skip
				? html`<div data-slot="secondary">
						<button type="button" data-component="button" data-color="ghost" data-action="skip">${skip}</button>
					</div>`
				: ''}
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
