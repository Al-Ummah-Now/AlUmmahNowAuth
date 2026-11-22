/**
 * The sign-in page's two options for an email with no password (routes.ts).
 *
 * The issuer renders the password sign-in page; this adds, after its form, the
 * "no password yet" block (Email me a sign-in link / Add a password) and the
 * script that shows it. Once the email is typed (change, blur, or Continue with
 * an empty password) the script asks POST /sign-in/method; with no password the
 * password field, Continue and the footer step aside for the two options.
 * Without JavaScript, a sign-in POST for such an email comes back with the
 * options already showing (`noPassword`).
 *
 * The link's own form carries the typed email as `link_email`, never `email`:
 * the page then has exactly one `input[name="email"]` (the sign-in field), so
 * password managers, scripts and tests that look the field up by name find
 * that one, never the hidden copy (it broke every sign-in helper, v2026.11.22.3).
 *
 * The register page with `setup=1` (from "Add a password") gets the title
 * "Add a password", its explanation, and the email typed on the sign-in page.
 */
import { CSRF_COOKIE, LINK_EMAIL_FIELD, SETUP_EMAIL_KEY, SIGN_IN_LINK_PATH, SIGN_IN_METHOD_PATH, signInLinkCopy, type Lang } from './routes';

const LOGIN_FORM = '<form data-component="form" method="post">';

const STYLE = `
/* data-component="form": the same inset and gap as the sign-in form above it */
[data-aun-no-password][hidden] { display:none; }
/* The link's form only carries its fields: its button lines up with the others */
[data-aun-no-password] form { display:contents; }
[data-aun-no-password] [data-component="button"] { width:100%; text-decoration:none; text-align:center; }
[data-aun-no-password] [data-component="button"][data-color="ghost"] { background:transparent; color:inherit; border:1px solid color-mix(in srgb, currentColor 55%, transparent); box-shadow:none; }
[data-aun-no-password] [data-slot="hint"] { font-size:var(--font-size-sm); opacity:.85; margin:0; }
form[data-aun-mode="no-password"] input[name="password"],
form[data-aun-mode="no-password"] > button[data-component="button"],
form[data-aun-mode="no-password"] [data-component="form-footer"],
form[data-aun-mode="no-password"] [data-component="form-alert"] { display:none; }
`;

const escapeAttr = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeText = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function script(lang: Lang): string {
	const cfg = { method: SIGN_IN_METHOD_PATH, key: SETUP_EMAIL_KEY, lang };
	const json = JSON.stringify(cfg).replace(/</g, '\\u003c');
	return `(function(){
var C=${json};
var f=document.querySelector('form[data-aun-login]'),box=document.querySelector('[data-aun-no-password]');
if(!f||!box)return;
var em=f.querySelector('input[name="email"]'),pw=f.querySelector('input[name="password"]'),go=f.querySelector(':scope > button[data-component="button"]');
var lf=box.querySelector('form'),hid=lf.querySelector('input[name="${LINK_EMAIL_FIELD}"]'),add=box.querySelector('[data-aun-add-password]');
if(!em||!pw)return;
var checked=f.getAttribute('data-aun-mode')==='no-password'?em.value.trim().toLowerCase():'',seq=0,asking='',waiters=[];
if(checked)pw.required=false;
function mode(on){if(on){f.setAttribute('data-aun-mode','no-password');pw.required=false;box.hidden=false;hid.value=em.value.trim();}else{f.removeAttribute('data-aun-mode');pw.required=true;box.hidden=true;}}
function check(then){var v=em.value.trim().toLowerCase();
 if(!v||!em.checkValidity()){mode(false);if(then)then(null);return;}
 if(v===checked){if(then)then(f.getAttribute('data-aun-mode')==='no-password');return;}
 // One lookup per email: change and blur fire together, and a click may come while it runs
 if(then)waiters.push(then);
 if(v===asking)return;
 asking=v;var n=++seq,ws=waiters;
 function done(r){if(n!==seq)return;asking='';waiters=[];ws.forEach(function(w){w(r);});}
 fetch(C.method,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify({email:v})})
 .then(function(r){return r.ok?r.json():null;})
 .then(function(j){if(n!==seq)return;if(!j||typeof j.password!=='boolean'){done(null);return;}checked=v;mode(!j.password);done(!j.password);},function(){done(null);});}
em.addEventListener('change',function(){check();});
em.addEventListener('blur',function(){check();});
em.addEventListener('input',function(){if(em.value.trim().toLowerCase()!==checked&&f.getAttribute('data-aun-mode'))mode(false);});
// Continue with an empty password: look the email up first, never ask for a password it doesn't have
if(go)go.addEventListener('click',function(e){if(pw.value||!em.value.trim()||!em.checkValidity())return;e.preventDefault();check(function(none){if(none)return;pw.focus();if(f.reportValidity)f.reportValidity();});});
if(add)add.addEventListener('click',function(){try{sessionStorage.setItem(C.key,em.value.trim());}catch(_){}});
// A browser that filled the email in by itself
if(!checked&&em.value.trim())check();
})();`;
}

/**
 * The sign-in page HTML with the two options added; unchanged when the page is
 * not the password sign-in form or has no "Create account" link (no email: then
 * neither option can work).
 */
export function addNoPasswordOptions(
	page: string,
	opts: { lang: Lang; csrf: string; back: string; noPassword?: boolean; email?: string }
): string {
	const start = page.indexOf(LOGIN_FORM);
	if (start < 0) return page;
	const end = page.indexOf('</form>', start);
	if (end < 0) return page;
	const form = page.slice(start, end);
	if (!form.includes('name="password"')) return page;
	const register = /href="(register\?[^"]*)"/.exec(form)?.[1];
	if (!register) return page;
	const t = signInLinkCopy(opts.lang);
	const setupHref = `${register}&amp;setup=1${opts.lang === 'ar' ? '&amp;lang=ar' : ''}`;
	const block = `<div data-component="form" data-aun-no-password${opts.noPassword ? '' : ' hidden'} data-testid="no-password-options">
<p data-component="description" style="margin:0">${escapeText(t.noPassword)}</p>
<form method="post" action="${SIGN_IN_LINK_PATH}">
<input type="hidden" name="csrf" value="${escapeAttr(opts.csrf)}"/>
<input type="hidden" name="${LINK_EMAIL_FIELD}" value="${escapeAttr(opts.email ?? '')}"/>
<input type="hidden" name="lang" value="${opts.lang}"/>
<input type="hidden" name="back" value="${escapeAttr(opts.back)}"/>
<button data-component="button" data-aun-email-link>${escapeText(t.link)}</button>
</form>
<a data-component="button" data-color="ghost" data-aun-add-password href="${setupHref}">${escapeText(t.addPassword)}</a>
<p data-slot="hint">${escapeText(t.hint)}</p>
</div><style>${STYLE}</style><script>${script(opts.lang)}</script>`;
	const marked = `<form data-component="form" method="post" data-aun-login${opts.noPassword ? ' data-aun-mode="no-password"' : ''}>`;
	const close = end + '</form>'.length;
	return page.slice(0, start) + marked + page.slice(start + LOGIN_FORM.length, close) + block + page.slice(close);
}

/** The register page from "Add a password" (`setup=1`): its title, explanation and the email typed at sign-in. */
export function addSetupHeading(page: string, lang: Lang): string {
	const start = page.indexOf(LOGIN_FORM);
	if (start < 0) return page;
	const t = signInLinkCopy(lang);
	// The first step (email + password + repeat) explains the code; the code step only keeps the title
	const firstStep = page.includes('name="repeat"');
	const heading = `<h1 data-component="title" data-testid="add-password-title">${escapeText(t.setupTitle)}</h1>${firstStep ? `<p data-component="description">${escapeText(t.setupText)}</p>` : ''}`;
	const prefill = firstStep
		? `<script>(function(){try{var v=sessionStorage.getItem(${JSON.stringify(SETUP_EMAIL_KEY)});var e=document.querySelector('form[data-component="form"] input[name="email"]');if(v&&e&&!e.value){e.value=v;var p=document.querySelector('form[data-component="form"] input[name="password"]');if(p)p.focus();}}catch(_){}})();</script>`
		: '';
	const at = start + LOGIN_FORM.length;
	return page.slice(0, at) + heading + page.slice(at).replace('</form>', `</form>${prefill}`);
}

export { CSRF_COOKIE };
