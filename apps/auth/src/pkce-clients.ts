/**
 * Clients whose authorization codes are only redeemed with PKCE (or client
 * authentication) at /token: openauth `pkce.requireForCodeExchange` (OA-1).
 * A code leaked through a log, a Referer or a proxy is useless without the
 * code_verifier that only the browser that started the sign-in holds.
 *
 * A client is listed once the PKCE-sending version of it is live in every
 * environment it signs in from. Ids are distinct per environment, so one
 * list serves QA, stage and production.
 *
 * Not listed yet: the videos site (web) and its admin (admin-web) send PKCE
 * from the monorepo release that follows AlUmmahNow#559. After the
 * owner's release tag, append their ids to the list:
 *   'e0de3c30-0304-4ac4-86d6-1e185dec0439', 'f0de3c30-0304-4ac4-86d6-1e185dec0439', 'b24e39de-601d-463b-b50d-37a0a94e986b', 'a24e39de-601d-463b-b50d-37a0a94e986b',
 */
export const PKCE_REQUIRED_CLIENTS: readonly string[] = [
	'109a1087-6626-40f7-8a7f-7f42f83f4f30', // profile (QA, stage, production)
	'1448ed27-39a6-417d-b4c8-07f881e81269', // auth admin (stage, production)
	'2448ed27-39a6-417d-b4c8-07f881e81269', // auth admin (QA)
];
