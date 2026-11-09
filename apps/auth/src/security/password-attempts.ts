/**
 * Attempt limits for the password provider (AU-2).
 *
 * The 6-digit email code (register, forgot password) and the password sign-in
 * had no attempt limit, so parallel guesses across isolates and PoPs could find
 * a reset code in under an hour (account takeover). Counters live in D1 because
 * they must be strongly consistent: every check is ONE conditional statement
 * (`... WHERE attempts < N RETURNING`), so no number of concurrent requests can
 * get more than N attempts through.
 *
 * - Codes: `recordCode` stores the hash of the code `sendCode` just sent; the
 *   provider's `checkCode` hook calls `checkCode` for every submitted code. A
 *   code allows MAX_CODE_ATTEMPTS guesses, expires after CODE_TTL_SECONDS and is
 *   single-use. All guesses for one email are also capped per hour across
 *   resends (MAX_CODE_ATTEMPTS_PER_HOUR).
 * - Password sign-in: `reserveLoginAttempt` takes a slot before the password is
 *   checked (MAX_LOGIN_FAILURES per LOGIN_WINDOW_SECONDS per email) and
 *   `releaseLoginAttempt` gives it back when the sign-in succeeded, so the
 *   counter is "failed + in flight" and parallel guesses cannot overshoot.
 */

export const MAX_CODE_ATTEMPTS = 5;
export const CODE_TTL_SECONDS = 15 * 60;
export const MAX_CODE_ATTEMPTS_PER_HOUR = 20;
const CODE_WINDOW_SECONDS = 60 * 60;

export const MAX_LOGIN_FAILURES = 10;
export const LOGIN_WINDOW_SECONDS = 15 * 60;

const nowSeconds = () => Math.floor(Date.now() / 1000);

async function codeHash(email: string, code: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${email.toLowerCase()}\n${code}`));
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Stores the code just sent to `email`; replaces any earlier code (and its attempt count). */
export async function recordCode(db: D1Database, email: string, code: string, now = nowSeconds()): Promise<void> {
	await db
		.prepare(
			`INSERT INTO password_codes (email, code_hash, expires_at, attempts, window_start, window_attempts, created_at)
			 VALUES (?1, ?2, ?3, 0, 0, 0, ?4)
			 ON CONFLICT(email) DO UPDATE SET
			   code_hash = excluded.code_hash,
			   expires_at = excluded.expires_at,
			   attempts = 0,
			   created_at = excluded.created_at`
		)
		.bind(email.toLowerCase(), await codeHash(email, code), now + CODE_TTL_SECONDS, now)
		.run();
}

export type CodeCheck = 'ok' | 'wrong' | 'locked';

/**
 * Counts one guess for `email` and says whether `code` is its current code.
 * 'locked': a code was sent but has no attempt left, expired or was used; the
 * user has to request a new code. An email that never got a code (sendCode
 * sends nothing to unknown accounts) reads 'wrong', like a real account with a
 * wrong guess, so the answer does not reveal which emails have accounts.
 */
export async function checkCode(db: D1Database, email: string, code: string, now = nowSeconds()): Promise<CodeCheck> {
	const key = email.toLowerCase();
	const windowExpired = now - CODE_WINDOW_SECONDS;
	const row = await db
		.prepare(
			`UPDATE password_codes SET
			   attempts = attempts + 1,
			   window_attempts = CASE WHEN window_start <= ?3 THEN 1 ELSE window_attempts + 1 END,
			   window_start = CASE WHEN window_start <= ?3 THEN ?2 ELSE window_start END
			 WHERE email = ?1
			   AND attempts < ?4
			   AND expires_at > ?2
			   AND (window_start <= ?3 OR window_attempts < ?5)
			 RETURNING code_hash`
		)
		.bind(key, now, windowExpired, MAX_CODE_ATTEMPTS, MAX_CODE_ATTEMPTS_PER_HOUR)
		.first<{ code_hash: string }>();
	if (!row) {
		const exists = await db.prepare(`SELECT 1 AS x FROM password_codes WHERE email = ?1`).bind(key).first();
		return exists ? 'locked' : 'wrong';
	}
	const hash = await codeHash(email, code);
	if (!timingSafeEqualHex(hash, row.code_hash)) return 'wrong';
	// Single use: only the request that flips it gets 'ok'
	const used = await db
		.prepare(`UPDATE password_codes SET expires_at = 0 WHERE email = ?1 AND code_hash = ?2 AND expires_at > ?3 RETURNING email`)
		.bind(key, hash, now)
		.first();
	return used ? 'ok' : 'locked';
}

/** Takes a sign-in slot for `email`; false when the window's failures are used up. */
export async function reserveLoginAttempt(db: D1Database, email: string, now = nowSeconds()): Promise<boolean> {
	const windowExpired = now - LOGIN_WINDOW_SECONDS;
	const row = await db
		.prepare(
			`INSERT INTO password_login_attempts (email, window_start, failures) VALUES (?1, ?2, 1)
			 ON CONFLICT(email) DO UPDATE SET
			   failures = CASE WHEN window_start <= ?3 THEN 1 ELSE failures + 1 END,
			   window_start = CASE WHEN window_start <= ?3 THEN ?2 ELSE window_start END
			 WHERE window_start <= ?3 OR failures < ?4
			 RETURNING failures`
		)
		.bind(email.toLowerCase(), now, windowExpired, MAX_LOGIN_FAILURES)
		.first<{ failures: number }>();
	return !!row;
}

/** Gives back the slot of a sign-in that succeeded. */
export async function releaseLoginAttempt(db: D1Database, email: string): Promise<void> {
	await db
		.prepare(`UPDATE password_login_attempts SET failures = MAX(failures - 1, 0) WHERE email = ?1`)
		.bind(email.toLowerCase())
		.run();
}

/** Hourly cron: drop rows that no longer limit anything. */
export async function purgeExpiredAttempts(db: D1Database, now = nowSeconds()): Promise<void> {
	await db.batch([
		db
			.prepare(`DELETE FROM password_codes WHERE expires_at <= ?1 AND window_start <= ?2`)
			.bind(now, now - CODE_WINDOW_SECONDS),
		db.prepare(`DELETE FROM password_login_attempts WHERE window_start <= ?1`).bind(now - LOGIN_WINDOW_SECONDS),
	]);
}

function timingSafeEqualHex(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}
