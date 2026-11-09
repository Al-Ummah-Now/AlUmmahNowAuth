/**
 * Deep health check (`GET /health?deep=1`) for release smoke tests.
 *
 * Proves the deployed version has the bindings it needs: the 2026-11-07 incident
 * deployed a config without Secrets Store bindings, and registration only failed
 * when a user tried it. Reports pass/fail booleans plus the environment name and
 * issuer (already public via /.well-known metadata); never secret values or errors.
 */
import { logger } from './logger';

export const REQUIRED_SECRETS = ['CLIENT_SECRET_SALT', 'KEY_ENCRYPTION_MASTER_KEY', 'RESEND_API_KEY', 'SESSION_SECRET'] as const;

const CHECK_TIMEOUT_MS = 3000;

/**
 * Resolves a secret binding without utils/secrets' module-level cache, so a
 * binding that stopped resolving is reported even in a warm isolate.
 */
async function secretResolves(binding: unknown): Promise<boolean> {
	if (typeof binding === 'string') return binding.length > 0;
	if (binding && typeof (binding as { get?: unknown }).get === 'function') {
		return !!(await (binding as { get: () => Promise<string> }).get());
	}
	return false;
}

async function probe(name: string, fn: () => Promise<boolean>): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const timeout = new Promise<boolean>((resolve) => {
			timer = setTimeout(() => resolve(false), CHECK_TIMEOUT_MS);
		});
		return await Promise.race([fn(), timeout]);
	} catch (error) {
		logger.warn('Deep health check failed', { check: name, error: error instanceof Error ? error.message : String(error) });
		return false;
	} finally {
		clearTimeout(timer);
	}
}

export interface DeepHealth {
	status: 'ok' | 'degraded';
	environment: string | null;
	issuer: string | null;
	/** Worker version that served this request (release smoke checks the candidate). */
	version: string | null;
	checks: Record<string, boolean>;
}

export async function deepHealth(env: Env): Promise<DeepHealth> {
	const raw = env as unknown as Record<string, unknown>;
	const issuer = typeof env.OPENAUTH_ISSUER === 'string' ? env.OPENAUTH_ISSUER : null;
	const environment = typeof env.ENVIRONMENT === 'string' ? env.ENVIRONMENT : null;

	const entries: [string, Promise<boolean>][] = [
		[
			'config',
			probe('config', async () => {
				if (!issuer || !environment) return false;
				const url = new URL(issuer);
				if (environment === 'development') return true;
				return url.protocol === 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1';
			}),
		],
		['d1', probe('d1', async () => (await env.AUTH_DB.prepare('SELECT 1 AS ok').first<{ ok: number }>())?.ok === 1)],
		[
			'kv',
			probe('kv', async () => {
				await env.AUTH_STORAGE.get('health:probe');
				return true;
			}),
		],
		['queue', probe('queue', async () => typeof env.AUDIT_QUEUE?.send === 'function')],
		// Password brute-force limits (AU-2); the D1 counters work without them, but
		// a deploy that lost the bindings must not pass the release smoke
		[
			'ratelimit',
			probe(
				'ratelimit',
				async () => typeof env.PASSWORD_IP_LIMITER?.limit === 'function' && typeof env.PASSWORD_EMAIL_LIMITER?.limit === 'function'
			),
		],
		...REQUIRED_SECRETS.map(
			(name) => [`secret:${name}`, probe(`secret:${name}`, () => secretResolves(raw[name]))] as [string, Promise<boolean>]
		),
	];

	const checks: Record<string, boolean> = {};
	for (const [name, result] of entries) checks[name] = await result;
	const status = Object.values(checks).every(Boolean) ? 'ok' : 'degraded';
	const version = (env as unknown as { CF_VERSION_METADATA?: { id?: string } }).CF_VERSION_METADATA?.id ?? null;
	return { status, environment, issuer, version, checks };
}
