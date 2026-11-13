/**
 * Unexpected Auth errors to the videos admin Errors page (AlUmmahNowAuth#341).
 *
 * The same pipeline as the videos Workers (AlUmmahNow docs/features/error-reporting.md):
 * one event per error, POSTed after the response (waitUntil) to admin-api
 * `/internal/errors` (ERRORS_INGEST_URL) with the internal key (INTERNAL_API_KEY,
 * Secrets Store). App `auth`. The ingest validates and scrubs again; here we keep
 * the message and stack, drop query strings and never send emails or tokens.
 *
 * It never throws and never delays the response. Per isolate the same error is
 * sent at most once every 10 s; repeats are counted into the next report, so a
 * failing dependency cannot flood the ingest.
 */
import { getSecret } from '../utils/secrets';
import { logger } from '../logger';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const DEDUPE_MS = 10_000;
const recent = new Map<string, { at: number; suppressed: number }>();
/** Warned once per isolate that reporting is off (never silent: an unreported 500 is invisible). */
let warnedDisabled = false;

function warnDisabled(reason: string, env: ErrorReportEnv): void {
	if (warnedDisabled) return;
	warnedDisabled = true;
	logger.error('ERROR REPORTING DISABLED: Auth errors are not reaching the admin Errors page', { reason, environment: env.ENVIRONMENT });
}

export interface ErrorReportEnv {
	ERRORS_INGEST_URL?: string;
	INTERNAL_API_KEY?: unknown;
	ENVIRONMENT?: string;
	CF_VERSION_METADATA?: { id?: string };
}

export interface ErrorDetails {
	route?: string;
	method?: string;
	status?: number;
	requestId?: string;
	kind?: 'unhandled' | 'http';
	/** E2E / probe errors: grouped as test, never alert, deleted after a day */
	test?: boolean;
	extra?: Record<string, string | number | boolean | null>;
}

/** A reference the user can quote (ERR-XXXX-XXXX, Crockford base32), as the videos apps show. */
export function newErrorRef(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(8));
	const chars = Array.from(bytes, (b) => ALPHABET[b & 31]).join('');
	return `ERR-${chars.slice(0, 4)}-${chars.slice(4, 8)}`;
}

/** Exposed for tests. */
export function resetErrorReporter(): void {
	recent.clear();
	warnedDisabled = false;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const TOKENISH = /\b(?:eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]*|[A-Za-z0-9_-]{40,})\b/g;
const scrub = (s: string | undefined, max: number) => s?.replace(EMAIL, '[email]').replace(TOKENISH, '[token]').slice(0, max);

/** The event for one error. Pure; exported for tests. */
export function buildErrorEvent(error: unknown, d: ErrorDetails, env: ErrorReportEnv, ref = newErrorRef()) {
	const err = error instanceof Error ? error : null;
	const message = err ? err.message || err.name : error != null ? String(error) : `HTTP ${d.status ?? 500}`;
	return {
		app: 'auth' as const,
		kind: d.kind ?? (error != null ? 'unhandled' : 'http'),
		ref,
		name: err?.name,
		message: scrub(message || 'Unknown error', 2000)!,
		stack: scrub(err?.stack, 8000),
		route: d.route,
		method: d.method,
		status: d.status ?? 500,
		requestId: d.requestId,
		environment: env.ENVIRONMENT,
		workerVersion: env.CF_VERSION_METADATA?.id,
		occurredAt: new Date().toISOString(),
		extra: d.extra,
		test: d.test || undefined,
		count: 1,
	};
}

/**
 * Reports an unexpected error and returns its reference (also when it was folded
 * into a later report or reporting is not configured, e.g. local dev).
 */
export function reportAuthError(
	env: ErrorReportEnv,
	ctx: { waitUntil(p: Promise<unknown>): void } | undefined,
	error: unknown,
	details: ErrorDetails = {},
	fetchImpl: typeof fetch = fetch
): string {
	try {
		const event = buildErrorEvent(error, details, env);
		const url = env?.ERRORS_INGEST_URL;
		if (!url) {
			if (env?.ENVIRONMENT && env.ENVIRONMENT !== 'development') warnDisabled('ERRORS_INGEST_URL is not set', env);
			return event.ref;
		}
		const fp = `${event.kind}|${event.name}|${event.message.replace(/\d+/g, '#').slice(0, 200)}|${event.route}`;
		const now = Date.now();
		const seen = recent.get(fp);
		if (seen && now - seen.at < DEDUPE_MS) {
			seen.suppressed += 1;
			return event.ref;
		}
		event.count = 1 + (seen?.suppressed ?? 0);
		recent.set(fp, { at: now, suppressed: 0 });
		if (recent.size > 500) recent.delete(recent.keys().next().value as string);
		const work = sendEvents(env, [event], fetchImpl).catch(() => undefined);
		try {
			ctx?.waitUntil(work);
		} catch {
			// outside a request: the promise still runs
		}
		return event.ref;
	} catch {
		return newErrorRef();
	}
}

/**
 * Posts events to the ingest now; returns its HTTP status, or a reason it could not
 * (used by the QA/stage probe route to prove reports arrive). Warns once when off.
 */
export async function sendEvents(env: ErrorReportEnv, events: ReturnType<typeof buildErrorEvent>[], fetchImpl: typeof fetch = fetch): Promise<number | 'no-url' | 'no-key'> {
	const url = env?.ERRORS_INGEST_URL;
	if (!url) {
		warnDisabled('ERRORS_INGEST_URL is not set', env ?? {});
		return 'no-url';
	}
	const key = await getSecret(env.INTERNAL_API_KEY, 'INTERNAL_API_KEY');
	if (!key) {
		warnDisabled('INTERNAL_API_KEY is not bound or empty', env);
		return 'no-key';
	}
	const res = await fetchImpl(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
		body: JSON.stringify({ events }),
	});
	if (res.status >= 400) logger.error('Error report refused by the ingest', { status: res.status });
	return res.status;
}
