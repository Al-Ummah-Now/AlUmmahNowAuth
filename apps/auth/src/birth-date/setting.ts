/** The `birth_date` setting (auth_settings), off until E20-P4: nothing asks for a date while it is off. */
import { getSetting, putSetting } from '../passkeys/store';

export const BIRTH_DATE_SETTING = 'birth_date';
const CACHE_MS = 30_000;
let cached: { at: number; on: boolean } | null = null;

export async function birthDateOn(db: D1Database, now = Date.now()): Promise<boolean> {
	if (cached && now - cached.at < CACHE_MS) return cached.on;
	const on = (await getSetting<{ on?: unknown }>(db, BIRTH_DATE_SETTING))?.on === true;
	cached = { at: now, on };
	return on;
}

export async function writeBirthDateSetting(db: D1Database, on: boolean, updatedBy: string): Promise<void> {
	await putSetting(db, BIRTH_DATE_SETTING, { on }, updatedBy);
	cached = null;
}

/** Tests only. */
export function clearBirthDateSettingCache(): void {
	cached = null;
}
