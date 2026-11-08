/**
 * E2E test support: the email-code sink and the test-route gate.
 * Spec: AlUmmahNow docs/release-pipeline/SPEC.md §9.2.
 *
 * On QA/stage, verification codes for addresses at E2E_EMAIL_DOMAIN are stored in
 * KV instead of being emailed, so E2E tests can read them without a Resend
 * account and without sending real mail. This must be impossible in production;
 * every one of these conditions is required:
 *   1. recipient domain is exactly E2E_EMAIL_DOMAIN (no MX record: undeliverable anyway)
 *   2. ENVIRONMENT is development, qa or stage
 *   3. the E2E_CODE_SINK_SECRET binding resolves (never bound in prod; CI config check)
 *   4. the issuer is not the production issuer
 */

export const E2E_EMAIL_DOMAIN = 'e2e.alummahnow.net';
export const E2E_SECRET_HEADER = 'X-E2E-Secret';
export const SINK_TTL_SECONDS = 600;
const PRODUCTION_ISSUER_HOST = 'auth.alummahnow.net';
const SINK_ENVIRONMENTS = new Set(['development', 'qa', 'stage']);

export interface E2ESinkEnv {
	ENVIRONMENT?: string;
	OPENAUTH_ISSUER?: string;
	E2E_CODE_SINK_SECRET?: unknown;
	AUTH_STORAGE: KVNamespace;
}

export const sinkKey = (email: string) => `test:email:${email.toLowerCase()}`;

/** Resolves a plain-string or Secrets Store binding; '' when absent or failing. */
async function resolveSecret(binding: unknown): Promise<string> {
	if (typeof binding === 'string') return binding;
	if (binding && typeof (binding as { get?: unknown }).get === 'function') {
		try {
			return (await (binding as { get: () => Promise<string> }).get()) || '';
		} catch {
			return '';
		}
	}
	return '';
}

function isNonProductionEnv(env: E2ESinkEnv): boolean {
	if (!env.ENVIRONMENT || !SINK_ENVIRONMENTS.has(env.ENVIRONMENT)) return false;
	try {
		return new URL(env.OPENAUTH_ISSUER ?? '').hostname !== PRODUCTION_ISSUER_HOST;
	} catch {
		return false;
	}
}

/** The secret, when test support is enabled in this deployment; otherwise ''. */
async function testSecret(env: E2ESinkEnv): Promise<string> {
	if (!isNonProductionEnv(env)) return '';
	return resolveSecret(env.E2E_CODE_SINK_SECRET);
}

export function isE2EAddress(email: string): boolean {
	const at = email.lastIndexOf('@');
	return at > 0 && email.slice(at + 1).toLowerCase() === E2E_EMAIL_DOMAIN;
}

/** True when a code for `email` must go to the sink instead of being emailed. */
export async function shouldSinkCode(env: E2ESinkEnv, email: string): Promise<boolean> {
	if (!isE2EAddress(email)) return false;
	return (await testSecret(env)) !== '';
}

export async function storeSinkCode(env: E2ESinkEnv, email: string, code: string): Promise<void> {
	await env.AUTH_STORAGE.put(sinkKey(email), JSON.stringify({ code, at: Date.now() }), {
		expirationTtl: SINK_TTL_SECONDS,
	});
}

function constantTimeEqual(a: string, b: string): boolean {
	const enc = new TextEncoder();
	const x = enc.encode(a);
	const y = enc.encode(b);
	let diff = x.length ^ y.length;
	for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
	return diff === 0;
}

/**
 * Gate for every /test/* route: test support must be enabled in this deployment
 * and the request must carry the secret. Callers answer 404 when false, so the
 * routes are not discoverable.
 */
export async function isAuthorizedTestRequest(env: E2ESinkEnv, request: Request): Promise<boolean> {
	const expected = await testSecret(env);
	if (!expected) return false;
	const provided = request.headers.get(E2E_SECRET_HEADER) ?? '';
	return constantTimeEqual(provided, expected);
}
