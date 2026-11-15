/**
 * Confidential clients that must authenticate with their client secret on the
 * authorization_code and refresh_token grants, PKCE or not: openauth
 * `requireClientAuthentication` (#211). A leaked code or refresh token of
 * these clients is useless without the secret.
 *
 * A client is listed once every consumer of it sends its secret on the code
 * exchange and on refresh. Public clients (browsers, apps) hold no secret
 * and are never listed: PKCE protects their codes (pkce-clients.ts).
 *
 * The Auth admin sends ADMIN_CLIENT_SECRET since #394.
 */
export const CONFIDENTIAL_CLIENTS: readonly string[] = [
	'1448ed27-39a6-417d-b4c8-07f881e81269', // auth admin (dev, stage, production)
	'2448ed27-39a6-417d-b4c8-07f881e81269', // auth admin (QA)
];
