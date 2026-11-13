/**
 * Cloudflare Turnstile and bot checks for the sign-in pages (docs/BOT_PROTECTION.md).
 *
 * TURNSTILE_MODE (wrangler var, per environment):
 * - "off"      no widget, no check (the default when unset or unknown)
 * - "monitor"  widget shown and tokens verified; failures are counted, never refused
 * - "enforce"  a missing or failed token is refused
 *
 * Keys: TURNSTILE_SITE_KEY (public, a var) and TURNSTILE_SECRET (Secrets Store in
 * production). Non-production environments use Cloudflare's official test keys:
 * the test secrets are answered here without calling siteverify, and pages load a
 * same-origin stub instead of challenges.cloudflare.com, so tests and CI never
 * talk to Turnstile. Production refuses test keys (the mode reads as "off" and an
 * error is logged).
 *
 * Bypass: outside production only, a request carrying X-AUN-Bot-Bypass signed
 * with BOT_BYPASS_SECRET (see signBypass) skips the widget and the check.
 * Production never honours it.
 *
 * Every outcome is one Analytics Engine data point (ABUSE_EVENTS), read by the
 * videos admin Abuse panel. No IPs, emails or tokens are written.
 */
import { logger } from '../logger';

export type TurnstileMode = 'off' | 'monitor' | 'enforce';

type Secret = string | { get(): Promise<string> } | undefined;

export interface TurnstileEnv {
	ENVIRONMENT?: string;
	TURNSTILE_MODE?: string;
	TURNSTILE_SITE_KEY?: string;
	TURNSTILE_SECRET?: Secret;
	BOT_BYPASS_SECRET?: Secret;
	ABUSE_EVENTS?: { writeDataPoint(point: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void };
}

/** Cloudflare's documented test keys (developers.cloudflare.com/turnstile/troubleshooting/testing/). */
export const TEST_SITE_KEYS = {
	pass: '1x00000000000000000000AA',
	passInvisible: '1x00000000000000000000BB',
	block: '2x00000000000000000000AB',
	interactive: '3x00000000000000000000FF',
} as const;
export const TEST_SECRETS = {
	pass: '1x0000000000000000000000000000000AA',
	fail: '2x0000000000000000000000000000000AA',
	spent: '3x0000000000000000000000000000000AA',
} as const;
/** The token the test site keys (and the stub) produce. */
export const TEST_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';

export const TURNSTILE_FIELD = 'cf-turnstile-response';
export const BYPASS_HEADER = 'X-AUN-Bot-Bypass';
/** A signed bypass is good for 6 hours either side of its timestamp (a long E2E run). */
export const BYPASS_MAX_AGE_SECONDS = 6 * 60 * 60;
export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
export const API_SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
/** Same-origin stand-in for api.js, served outside production for the test site keys. */
export const STUB_SCRIPT_PATH = '/turnstile/stub.js';

const isProduction = (env: TurnstileEnv) => env.ENVIRONMENT === 'production';
const isTestKey = (value: string | undefined) => !!value && /^[123]x0{20,}[A-F]{2}$/.test(value);

async function readSecret(secret: Secret): Promise<string | undefined> {
	if (!secret) return undefined;
	if (typeof secret === 'string') return secret || undefined;
	try {
		return (await secret.get()) || undefined;
	} catch (error) {
		logger.error('Turnstile: could not read a secret binding', { error: error instanceof Error ? error.message : String(error) });
		return undefined;
	}
}

/** The mode in force. Production with a test key or without a site key reads as "off". */
export function turnstileMode(env: TurnstileEnv): TurnstileMode {
	const mode = env.TURNSTILE_MODE === 'enforce' || env.TURNSTILE_MODE === 'monitor' ? env.TURNSTILE_MODE : 'off';
	if (mode === 'off') return 'off';
	if (!env.TURNSTILE_SITE_KEY) {
		logger.error('Turnstile: TURNSTILE_MODE is on but TURNSTILE_SITE_KEY is not set; treating as off');
		return 'off';
	}
	if (isProduction(env) && isTestKey(env.TURNSTILE_SITE_KEY)) {
		logger.error('Turnstile: a test site key is configured in production; treating as off');
		return 'off';
	}
	return mode;
}

/** Where the page loads the widget script from: the stub for test keys outside production. */
export function widgetScriptUrl(env: TurnstileEnv): string {
	return !isProduction(env) && isTestKey(env.TURNSTILE_SITE_KEY) ? STUB_SCRIPT_PATH : API_SCRIPT_URL;
}

export type VerifyOutcome = 'pass' | 'missing' | 'fail' | 'error';

export interface VerifyResult {
	outcome: VerifyOutcome;
	/** siteverify error codes (or ours: "test-secret-in-production", "no-secret") */
	codes: string[];
}

/** Checks one widget token with siteverify (or locally for the test secrets outside production). */
export async function verifyTurnstileToken(
	env: TurnstileEnv,
	token: string | null | undefined,
	opts: { ip?: string; fetcher?: typeof fetch } = {}
): Promise<VerifyResult> {
	if (!token) return { outcome: 'missing', codes: ['missing-input-response'] };
	if (token.length > 2048) return { outcome: 'fail', codes: ['invalid-input-response'] };
	const secret = await readSecret(env.TURNSTILE_SECRET);
	if (!secret) {
		logger.error('Turnstile: TURNSTILE_SECRET is not set');
		return { outcome: 'error', codes: ['no-secret'] };
	}
	if (isTestKey(secret)) {
		if (isProduction(env)) {
			logger.error('Turnstile: a test secret is configured in production');
			return { outcome: 'error', codes: ['test-secret-in-production'] };
		}
		if (secret === TEST_SECRETS.pass) return { outcome: 'pass', codes: [] };
		if (secret === TEST_SECRETS.spent) return { outcome: 'fail', codes: ['timeout-or-duplicate'] };
		return { outcome: 'fail', codes: ['invalid-input-response'] };
	}
	const body = new FormData();
	body.set('secret', secret);
	body.set('response', token);
	if (opts.ip && opts.ip !== 'unknown') body.set('remoteip', opts.ip);
	try {
		const res = await (opts.fetcher ?? fetch)(SITEVERIFY_URL, { method: 'POST', body, signal: AbortSignal.timeout(5000) });
		if (!res.ok) return { outcome: 'error', codes: [`http-${res.status}`] };
		const data = (await res.json()) as { success?: boolean; 'error-codes'?: string[] };
		const codes = Array.isArray(data['error-codes']) ? data['error-codes'].map(String).slice(0, 5) : [];
		if (data.success) return { outcome: 'pass', codes };
		// Our own key or secret is wrong: a configuration fault, not a bot
		if (codes.some((c) => c === 'invalid-input-secret' || c === 'missing-input-secret')) return { outcome: 'error', codes };
		return { outcome: 'fail', codes };
	} catch (error) {
		logger.error('Turnstile: siteverify unreachable', { error: error instanceof Error ? error.message : String(error) });
		return { outcome: 'error', codes: ['siteverify-unreachable'] };
	}
}

function toHex(buffer: ArrayBuffer): string {
	return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacHex(secret: string, message: string): Promise<string> {
	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	return toHex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
}

function constantTimeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/** The X-AUN-Bot-Bypass value for `now` (unix seconds): "v1.<ts>.<hmac-sha256 hex of 'v1.<ts>'>". */
export async function signBypass(secret: string, now = Math.floor(Date.now() / 1000)): Promise<string> {
	const payload = `v1.${now}`;
	return `${payload}.${await hmacHex(secret, payload)}`;
}

/** True when the request carries a valid signed bypass and this is not production. */
export async function hasValidBypass(env: TurnstileEnv, request: Request, now = Math.floor(Date.now() / 1000)): Promise<boolean> {
	if (isProduction(env)) return false;
	const value = request.headers.get(BYPASS_HEADER);
	if (!value) return false;
	const match = /^v1\.(\d{9,11})\.([0-9a-f]{64})$/.exec(value);
	if (!match) return false;
	if (Math.abs(now - Number(match[1])) > BYPASS_MAX_AGE_SECONDS) return false;
	const secret = await readSecret(env.BOT_BYPASS_SECRET);
	if (!secret) return false;
	return constantTimeEqual(await hmacHex(secret, `v1.${match[1]}`), match[2]);
}

export type AbuseKind =
	| 'turnstile_pass'
	| 'turnstile_fail'
	| 'turnstile_missing'
	| 'turnstile_error'
	| 'rate_limited'
	| 'bad_user_agent'
	| 'bypass';

/** One counter point: blobs = [app, endpoint, kind, environment]. Never personal data. */
export function recordAbuse(env: TurnstileEnv, endpoint: string, kind: AbuseKind): void {
	try {
		env.ABUSE_EVENTS?.writeDataPoint({ indexes: ['auth'], blobs: ['auth', endpoint, kind, env.ENVIRONMENT ?? 'development'], doubles: [1] });
	} catch (error) {
		logger.warn('Abuse counter write failed', { error: error instanceof Error ? error.message : String(error) });
	}
}

export interface HumanCheck {
	/** False only in "enforce" mode when the token is missing or failed. */
	allowed: boolean;
	outcome: VerifyOutcome | 'off' | 'bypass';
}

/**
 * The whole check for one form post: mode, bypass, token. A siteverify outage
 * (outcome "error") is allowed through and counted: the rate limits still apply,
 * and an outage at Cloudflare must not stop every sign-up.
 */
export async function checkHuman(
	env: TurnstileEnv,
	request: Request,
	token: string | null | undefined,
	endpoint: string,
	opts: { ip?: string; fetcher?: typeof fetch } = {}
): Promise<HumanCheck> {
	const mode = turnstileMode(env);
	if (mode === 'off') return { allowed: true, outcome: 'off' };
	if (await hasValidBypass(env, request)) {
		recordAbuse(env, endpoint, 'bypass');
		return { allowed: true, outcome: 'bypass' };
	}
	const { outcome, codes } = await verifyTurnstileToken(env, token, opts);
	recordAbuse(env, endpoint, outcome === 'pass' ? 'turnstile_pass' : outcome === 'missing' ? 'turnstile_missing' : outcome === 'fail' ? 'turnstile_fail' : 'turnstile_error');
	if (outcome !== 'pass') logger.warn('Turnstile check did not pass', { endpoint, outcome, codes, mode });
	return { allowed: outcome === 'pass' || outcome === 'error' || mode === 'monitor', outcome };
}

/**
 * Command-line and scripting clients that never fill in a sign-in form. Browsers,
 * our native apps (okhttp, CFNetwork, Ktor, Dart) and crawlers are not listed.
 */
const BAD_AGENT = /^(curl|wget|python-requests|python-urllib|python-httpx|aiohttp|go-http-client|java\/|libwww-perl|lwp-|scrapy|httpie|php\/|ruby|masscan|zgrab|nikto|sqlmap|nuclei)/i;

export function isBadUserAgent(userAgent: string | null): boolean {
	const ua = (userAgent ?? '').trim();
	return ua === '' || BAD_AGENT.test(ua);
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (value: string) => value.replace(/[&<>"']/g, (c) => ESCAPES[c]);

const WIDGET_COPY = {
	checking: { en: 'Checking that you are not a robot…', ar: 'جارٍ التحقق من أنك لست روبوتًا…' },
	failed: {
		en: 'We could not confirm that you are not a robot. Reload the page and try again.',
		ar: 'تعذّر التأكد من أنك لست روبوتًا. أعد تحميل الصفحة ثم حاول مرة أخرى.',
	},
} as const;

/** The "please confirm" message shown when a post was refused for a missing or failed check. */
export const HUMAN_CHECK_FAILED = {
	en: 'Please confirm that you are not a robot, then try again.',
	ar: 'يُرجى تأكيد أنك لست روبوتًا، ثم المحاولة مرة أخرى.',
} as const;

/**
 * Adds the widget to a sign-in page: a container at the end of the first form
 * (shown only when Cloudflare needs the visitor to click: appearance
 * "interaction-only"), a status line for screen readers, and a script that puts
 * the token into whichever form is submitted. A form submitted before the token
 * is ready waits for it and is then sent; when the widget cannot run (blocked,
 * offline) the form is sent without a token and the server decides.
 */
export function injectTurnstile(html: string, opts: { siteKey: string; scriptUrl: string; action: string; lang: 'en' | 'ar' }): string {
	if (!html.includes('</form>') || html.includes('data-aun-turnstile')) return html;
	const { lang } = opts;
	const widget =
		`<div data-aun-turnstile data-sitekey="${esc(opts.siteKey)}" data-action="${esc(opts.action)}" data-lang="${lang}" style="display:flex;justify-content:center;min-height:0"></div>` +
		`<p data-aun-turnstile-status role="status" aria-live="polite" style="margin:0;font-size:.875rem;min-height:0"></p>`;
	const script =
		`<script>(function(){var el=document.querySelector('[data-aun-turnstile]');if(!el)return;` +
		`var st=document.querySelector('[data-aun-turnstile-status]');var token='';var pending=null;var broken=false;` +
		`var say=function(t){if(st)st.textContent=t;};` +
		`var send=function(f){var i=f.querySelector('input[name="${TURNSTILE_FIELD}"]');if(!i){i=document.createElement('input');i.type='hidden';i.name='${TURNSTILE_FIELD}';f.appendChild(i);}i.value=token;HTMLFormElement.prototype.submit.call(f);};` +
		`window.aunTurnstileReady=function(){try{window.turnstile.render(el,{sitekey:el.dataset.sitekey,action:el.dataset.action,language:el.dataset.lang,appearance:'interaction-only','response-field':false,'refresh-expired':'auto',` +
		`callback:function(t){token=t;say('');if(pending){var f=pending;pending=null;send(f);}},` +
		`'expired-callback':function(){token='';},` +
		`'error-callback':function(){broken=true;say(${JSON.stringify(WIDGET_COPY.failed[lang])});if(pending){var f=pending;pending=null;send(f);}return true;}});}catch(e){broken=true;}};` +
		`document.addEventListener('submit',function(e){var f=e.target;if(!(f instanceof HTMLFormElement)||f.method.toLowerCase()!=='post')return;e.preventDefault();` +
		`if(token||broken){send(f);return;}pending=f;say(${JSON.stringify(WIDGET_COPY.checking[lang])});},true);})();</script>` +
		`<script src="${esc(opts.scriptUrl)}?onload=aunTurnstileReady&amp;render=explicit" async defer></script>`;
	const formEnd = html.indexOf('</form>');
	let out = html.slice(0, formEnd) + widget + html.slice(formEnd);
	const bodyEnd = out.lastIndexOf('</body>');
	out = bodyEnd === -1 ? out + script : out.slice(0, bodyEnd) + script + out.slice(bodyEnd);
	return out;
}

/** Outside production: a stand-in for api.js that renders nothing and answers with the test token. */
export const STUB_SCRIPT = `(function(){var cbs={};var n=0;window.turnstile={render:function(el,o){var id='stub-'+(++n);cbs[id]=o||{};setTimeout(function(){if(o&&o.callback)o.callback('${TEST_TOKEN}');},0);return id;},` +
	`reset:function(id){var o=cbs[id];if(o&&o.callback)setTimeout(function(){o.callback('${TEST_TOKEN}');},0);},remove:function(id){delete cbs[id];},getResponse:function(){return '${TEST_TOKEN}';},execute:function(){},ready:function(f){f();}};` +
	`var s=document.currentScript;var m=s&&/[?&]onload=([A-Za-z_$][\\w$]*)/.exec(s.src);if(m&&typeof window[m[1]]==='function')window[m[1]]();})();`;

/** GET /turnstile/stub.js outside production; null in production (404 from the issuer). */
export function stubScriptResponse(env: TurnstileEnv): Response | null {
	if (isProduction(env)) return null;
	return new Response(STUB_SCRIPT, { headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=300' } });
}
