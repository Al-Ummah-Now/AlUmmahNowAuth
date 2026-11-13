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
 * Every first-party web client is listed: videos (web), its admin (admin-web),
 * www and the CMS all send PKCE S256 in QA, stage and production (checked
 * live in the SSO audit, 2026-11-10).
 */
export const PKCE_REQUIRED_CLIENTS: readonly string[] = [
	'109a1087-6626-40f7-8a7f-7f42f83f4f30', // profile (QA, stage, production)
	'1448ed27-39a6-417d-b4c8-07f881e81269', // auth admin (stage, production)
	'2448ed27-39a6-417d-b4c8-07f881e81269', // auth admin (QA)
	'e0de3c30-0304-4ac4-86d6-1e185dec0439', // videos web (QA)
	'f0de3c30-0304-4ac4-86d6-1e185dec0439', // videos web (stage, production)
	'b24e39de-601d-463b-b50d-37a0a94e986b', // videos admin (QA)
	'a24e39de-601d-463b-b50d-37a0a94e986b', // videos admin (stage, production)
	'ecda6f18-89cb-415c-b746-7e77184d75a2', // www (QA)
	'd34701ed-03de-43f8-95a8-91cd1e1874bb', // www (stage, production)
	'0e613f49-674b-490a-93e5-97a35d586da1', // CMS (QA)
	'd06fd65a-5b79-45bc-8bfd-a856b8502330', // CMS (stage, production)
	'0abd9eac-e47e-4a1a-90bd-18cffec0303c', // scholar sites (QA)
	'81f2bb95-15c6-4896-b414-be2c24155a74', // scholar sites (stage, production)
];
