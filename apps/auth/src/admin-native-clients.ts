/**
 * The native "Al Ummah Now Admin" apps (wiki AUN-ADMIN-NATIVE): iOS, macOS,
 * Windows and Android, prod/stage and QA ids (migrations 0036, 0039, 0040).
 * They are for staff only: a refresh at one of them is refused once the user
 * holds no staff role (AlUmmahNowAuth#363), so losing the role signs every
 * Admin install out at its next refresh.
 */
export const ADMIN_NATIVE_CLIENT_IDS: ReadonlySet<string> = new Set([
	// prod + stage
	'95adb86e-fdfb-4955-984b-347aa16a5023', // Admin (iOS)
	'6a65d365-1352-4ffa-922f-4053d461ac3a', // Admin (macOS)
	'288b80b9-ecc6-4927-8b5a-bded5aa00e55', // Admin (Windows)
	'6634c4c9-a80d-4961-9427-d997349f8ea2', // Admin (Android)
	// QA
	'77330b47-5747-4058-ba00-921e159f1ced', // Admin (iOS)
	'1c230211-7b90-4d0a-be9d-3068ebd79d5b', // Admin (macOS)
	'306b6f10-d9f0-4609-84a1-23c92da978e9', // Admin (Windows)
	'5b44a4f7-d369-4d12-bc69-028d0276604a', // Admin (Android)
]);
