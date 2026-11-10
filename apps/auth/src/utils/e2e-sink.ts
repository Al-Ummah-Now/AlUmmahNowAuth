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

export function constantTimeEqual(a: string, b: string): boolean {
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

// ------------------------------------------------------------ E2E run accounts

/**
 * Accounts an E2E CI run registers for itself and deletes when it ends:
 * e2e+<run id>-<attempt>-<name>@e2e.alummahnow.net (AlUmmahNow apps/web/e2e,
 * apps/admin-web/e2e, the release suite). routes/test-run-users.ts deletes them.
 */
export const RUN_USER_EMAIL = /^e2e\+\d{1,20}-\d{1,3}-[a-z0-9][a-z0-9-]{0,62}@e2e\.alummahnow\.net$/;

export function isRunUserEmail(email: string): boolean {
	return RUN_USER_EMAIL.test(email);
}

/** The flag value that turns the run-account support on (wrangler vars, QA and stage only). */
export const RUN_USERS_FLAG = 'enabled';

export interface RunUsersEnv extends E2ESinkEnv {
	/** "enabled" on QA and stage (wrangler vars); never set in production (release check + test). */
	E2E_RUN_USERS?: string;
	TEST_PROMOTE_SECRET?: string;
}

/**
 * Run-account support (the provisioning marker and the /test/run-users routes)
 * needs ALL of: the E2E_RUN_USERS flag, a non-production environment and issuer,
 * the E2E_CODE_SINK_SECRET binding and the TEST_PROMOTE_SECRET secret.
 */
export async function runUsersEnabled(env: RunUsersEnv): Promise<boolean> {
	if (env.E2E_RUN_USERS !== RUN_USERS_FLAG) return false;
	if (typeof env.TEST_PROMOTE_SECRET !== 'string' || env.TEST_PROMOTE_SECRET.length < 16) return false;
	return (await testSecret(env)) !== '';
}

/** users.metadata key the provisioning path sets; only accounts carrying it can be deleted by the run routes. */
export const RUN_USER_MARKER = 'e2eRun';

/**
 * Called right after a registration creates an account: a run address on a
 * deployment with run-account support gets the marker. Never throws.
 */
export async function markRunUser(env: RunUsersEnv, db: D1Database | undefined, user: { id: string; email: string }): Promise<boolean> {
	try {
		if (!db || !isRunUserEmail(user.email.toLowerCase()) || !(await runUsersEnabled(env))) return false;
		const marker = JSON.stringify({ via: 'e2e-sink-registration', at: Date.now() });
		await db
			.prepare(`UPDATE users SET metadata = json_set(coalesce(metadata, '{}'), '$.${RUN_USER_MARKER}', json(?)) WHERE id = ?`)
			.bind(marker, user.id)
			.run();
		return true;
	} catch {
		return false;
	}
}
