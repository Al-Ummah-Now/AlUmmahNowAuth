/**
 * GET and PUT /account/birth-date (wiki E20 §5.1): the person's own date, through the Profile app only.
 *
 * Only a token issued to the Profile app is accepted, so no other app's token can read the date. A change needs a
 * sign-in at most 10 minutes old. Nobody makes themselves older: a later change stays in the same band or goes to a
 * younger one. The date is in no log, audit event or answer but the person's own.
 */
import { getAuditEmitter } from '../audit-emitter';
import { AuditEventSeverity, AuditEventType, createAuditEvent } from '../audit-events';
import { logger } from '../logger';
import { RATE_LIMIT_PERIOD_SECONDS, withinRateLimit } from '../rate-limit';
import { isRevoked, readRevocationForRefresh } from '../revocation/revocation-list';
import { requireRecentSignIn, verifyUserAccessToken, type VerifiedUser } from '../routes/account-routes';
import { bandOf, isOlderBand, isPlausible, parseBirthDate } from './date';
import { ProfileKeyMissingError } from './key';
import { birthDateOn } from './setting';
import { readBirthDate, writeBirthDate, type BirthDateEnv } from './store';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store', ...headers } });
const fail = (status: number, error: string, description: string, headers?: Record<string, string>) => json({ error, error_description: description }, status, headers);

const MAX_BODY_BYTES = 200;
const WRITE_ATTEMPTS = 3;

/** The person behind a Profile token, still signed in and still active; or the refusal. */
async function caller(request: Request, env: Env): Promise<VerifiedUser | Response> {
	if (!(await birthDateOn(env.AUTH_DB))) return fail(404, 'feature_off', 'Not found.');
	const user = await verifyUserAccessToken(request, env);
	if (user instanceof Response) return user;
	if (!env.PROFILE_CLIENT_ID || user.clientId !== env.PROFILE_CLIENT_ID) {
		return fail(403, 'forbidden', 'Only the Profile app may use this.');
	}
	const [revocation, row] = await Promise.all([
		readRevocationForRefresh({ kv: env.TOKEN_REVOCATIONS, db: env.AUTH_DB }, user.userId),
		env.AUTH_DB.prepare(`SELECT 1 AS ok FROM users WHERE id = ? AND status = 'active' AND deleted_at IS NULL`).bind(user.userId).first(),
	]);
	if (isRevoked(revocation, { authTime: user.authTime }) || !row) {
		return fail(401, 'invalid_token', 'The access token is invalid or expired', { 'WWW-Authenticate': 'Bearer error="invalid_token"' });
	}
	return user;
}

/** A missing key or unreadable row is our problem, never "no date". */
function unavailable(error: unknown): Response {
	// The error's own text may quote what was being read
	logger.error('[birth-date] Not available', { reason: error instanceof ProfileKeyMissingError ? 'key_missing' : 'failed' });
	return fail(503, 'temporarily_unavailable', 'Try again in a moment.');
}

export async function handleGetBirthDate(request: Request, env: Env): Promise<Response> {
	const user = await caller(request, env);
	if (user instanceof Response) return user;
	try {
		return json({ birthDate: (await readBirthDate(env as BirthDateEnv, user.userId))?.birthDate ?? null });
	} catch (error) {
		return unavailable(error);
	}
}

async function requestedDate(request: Request): Promise<string | null> {
	const text = await request.text();
	if (text.length > MAX_BODY_BYTES) return null;
	try {
		const body = JSON.parse(text) as unknown;
		const value = body && typeof body === 'object' ? (body as { birthDate?: unknown }).birthDate : null;
		return typeof value === 'string' ? value : null;
	} catch {
		return null;
	}
}

export async function handlePutBirthDate(request: Request, env: Env, ctx: ExecutionContext, requestId: string): Promise<Response> {
	const user = await caller(request, env);
	if (user instanceof Response) return user;
	const stale = requireRecentSignIn(user, Date.now(), 'Sign in again to save your date of birth');
	if (stale) return stale;
	if (!(await withinRateLimit(env.BIRTH_DATE_LIMITER, `birth-date:${user.userId}`))) {
		return fail(429, 'rate_limited', 'Too many requests. Try again later.', { 'Retry-After': String(RATE_LIMIT_PERIOD_SECONDS) });
	}
	const value = await requestedDate(request);
	const date = parseBirthDate(value);
	if (!value || !date || !isPlausible(date)) return fail(400, 'invalid_birth_date', 'This is not a date of birth.');
	const band = bandOf(date);
	// Until E20-P4 an under-13 date changes nothing; the setting stays off until then
	if (!band) return fail(403, 'under_minimum_age', 'This account can’t be used at this age.');

	try {
		for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
			const previous = await readBirthDate(env as BirthDateEnv, user.userId);
			if (previous?.birthDate === value) return json({ birthDate: value });
			const before = previous ? parseBirthDate(previous.birthDate) : null;
			if (before && isOlderBand(bandOf(before), band)) {
				return fail(409, 'older_age_refused', 'Contact us to correct your date of birth.');
			}
			if (!(await writeBirthDate(env as BirthDateEnv, user.userId, value, previous))) continue;
			ctx.waitUntil(
				getAuditEmitter().emit(
					createAuditEvent(previous ? AuditEventType.BIRTH_DATE_CHANGED : AuditEventType.BIRTH_DATE_SET, {
						severity: AuditEventSeverity.INFO,
						userId: user.userId,
						ipAddress: request.headers.get('CF-Connecting-IP'),
						userAgent: request.headers.get('User-Agent'),
						requestId,
						metadata: { initiatedBy: 'self', clientId: user.clientId },
					})
				)
			);
			return json({ birthDate: value });
		}
		return unavailable(new Error('contended'));
	} catch (error) {
		return unavailable(error);
	}
}
