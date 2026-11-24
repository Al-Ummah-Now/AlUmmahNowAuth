/**
 * The `age_band` claim (wiki E20 §5.1): the only thing said of a date of birth, and only in access tokens of the apps
 * that ask for it. Computed for each token, at sign-in and at each refresh, so a birthday reaches every app within one
 * token's life with no job. Never in `/userinfo`, ID tokens, webhooks or another client's token; stored nowhere.
 */
import { logger } from '../logger';
import { bandOf, parseBirthDate, type AgeBand } from './date';
import { birthDateOn } from './setting';
import { readBirthDate, type BirthDateEnv } from './store';

export const AGE_BAND_CLAIM = 'age_band';

/** The apps whose tokens the Videos API reads an age from. Ids are distinct per environment, so one list serves all. */
export const AGE_BAND_CLIENTS: ReadonlySet<string> = new Set([
	'e0de3c30-0304-4ac4-86d6-1e185dec0439', // videos web (QA)
	'f0de3c30-0304-4ac4-86d6-1e185dec0439', // videos web (stage, production)
	'567a2cbc-dab8-4d5c-9437-a9e61c7120f5', // Viewer (iOS / Android) (stage, production)
	'111648c6-24e6-4c35-8bcf-f50ab5c0d96d', // Viewer (TV) (stage, production)
	'f97abe68-ef61-41b6-bf08-d86650cc7cb3', // Viewer (desktop) (stage, production)
	'6f8073c6-754b-4d63-bf80-0546214e0d62', // Studio (iOS / Android) (stage, production)
	'950e2b3b-6353-4472-affe-7c1f57f4e6a4', // Studio (desktop) (stage, production)
	'31389afb-d4f8-4c26-9492-4c77f4d07e65', // Viewer (iOS / Android) (QA)
	'9c3a81c8-3f9c-4873-abb1-a51e4f1d9543', // Viewer (TV) (QA)
	'ce7de8a4-59dd-4682-ab4d-105399105294', // Viewer (desktop) (QA)
	'45364a42-21f4-4359-a76c-0a1e6615fd7b', // Studio (iOS / Android) (QA)
	'29b4792a-caad-4814-a83f-4337bc6a1aeb', // Studio (desktop) (QA)
]);

/** Extra access-token claims for one token. No date, no age, or an unreadable one: no claim (the API then asks for the date). */
export async function ageBandClaims(env: BirthDateEnv, token: { type: string; clientID: string; properties?: unknown }, now = Date.now()): Promise<{ age_band: AgeBand } | undefined> {
	const userId = (token.properties as { id?: unknown } | undefined)?.id;
	if (token.type !== 'user' || typeof userId !== 'string' || !userId || !AGE_BAND_CLIENTS.has(token.clientID)) return undefined;
	try {
		if (!(await birthDateOn(env.AUTH_DB, now))) return undefined;
		const stored = await readBirthDate(env, userId);
		const date = stored ? parseBirthDate(stored.birthDate) : null;
		const band = date ? bandOf(date, now) : null;
		return band ? { [AGE_BAND_CLAIM]: band } : undefined;
	} catch {
		// The error's own text may quote what was read
		logger.error('[birth-date] Band not computed; the token has none');
		return undefined;
	}
}

/** For `claims_supported`: listed only while the setting is on (wiki E20 §5.2, the Videos admin's check). */
export async function ageBandClaimsSupported(env: BirthDateEnv): Promise<string[]> {
	return (await birthDateOn(env.AUTH_DB)) ? [AGE_BAND_CLAIM] : [];
}
