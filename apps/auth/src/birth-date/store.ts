/** The encrypted date of birth (user_birth_dates), read and written one person at a time. */
import { decrypt, encrypt } from '../services/encryption';
import { parseBirthDate } from './date';
import { currentProfileKey, profileKeyById, type ProfileKeyEnv } from './key';

export interface BirthDateEnv extends ProfileKeyEnv {
	AUTH_DB: D1Database;
}

export interface StoredBirthDate {
	/** YYYY-MM-DD */
	birthDate: string;
	changedAt: number;
}

/** Binds a value to its owner: a row copied to another account does not decrypt. */
const boundTo = (userId: string) => `user_birth_dates:${userId}`;

export async function readBirthDate(env: BirthDateEnv, userId: string): Promise<StoredBirthDate | null> {
	const row = await env.AUTH_DB.prepare('SELECT birth_date_enc, key_id, changed_at FROM user_birth_dates WHERE user_id = ?')
		.bind(userId)
		.first<{ birth_date_enc: string; key_id: string; changed_at: number }>();
	if (!row) return null;
	const birthDate = await decrypt(row.birth_date_enc, await profileKeyById(env, row.key_id), boundTo(userId));
	if (!parseBirthDate(birthDate)) throw new Error('The stored date of birth is not a date');
	return { birthDate, changedAt: row.changed_at };
}

/**
 * Writes the date if the row is still the one that was read (`previous`; null: there was none), for an account
 * that is still active. False: something changed meanwhile, read again.
 */
export async function writeBirthDate(env: BirthDateEnv, userId: string, birthDate: string, previous: StoredBirthDate | null, now = Date.now()): Promise<boolean> {
	const key = await currentProfileKey(env);
	const sealed = await encrypt(birthDate, key, boundTo(userId));
	// Strictly increasing, so two writes in one millisecond can't both match the same previous row
	const changedAt = previous ? Math.max(now, previous.changedAt + 1) : now;
	const stmt = previous
		? env.AUTH_DB.prepare(
				`UPDATE user_birth_dates SET birth_date_enc = ?2, key_id = ?3, changed_at = ?4
				 WHERE user_id = ?1 AND changed_at = ?5 AND EXISTS (SELECT 1 FROM users WHERE id = ?1 AND status = 'active' AND deleted_at IS NULL)`
			).bind(userId, sealed, key.id, changedAt, previous.changedAt)
		: env.AUTH_DB.prepare(
				`INSERT INTO user_birth_dates (user_id, birth_date_enc, key_id, changed_at)
				 SELECT ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM users WHERE id = ?1 AND status = 'active' AND deleted_at IS NULL)
				 ON CONFLICT (user_id) DO NOTHING`
			).bind(userId, sealed, key.id, changedAt);
	return ((await stmt.run()).meta?.changes ?? 0) === 1;
}

export const deleteBirthDate = (db: D1Database, userId: string): D1PreparedStatement => db.prepare('DELETE FROM user_birth_dates WHERE user_id = ?').bind(userId);
