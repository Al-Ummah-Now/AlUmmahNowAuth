// OAuth client scopes supported by Auth. Custom service scopes are shared
// with the handlers that check them and the Admin client editor.
export const ACCOUNT_EVENTS_RECEIVE_SCOPE = "account-events:receive";
export const ACCOUNT_EXPORTS_WRITE_SCOPE = "account-exports:write";
export const MODERATION_CLIENT_SCOPE = "moderation:request";
export const INVITE_CLIENT_SCOPE = "invites:provision";
export const TOKEN_REVOKE_SCOPE = "tokens:revoke";

export const CLIENT_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "admin",
  "admin:users",
  "admin:roles",
  "admin:clients",
  "admin:audit",
  ACCOUNT_EVENTS_RECEIVE_SCOPE,
  ACCOUNT_EXPORTS_WRITE_SCOPE,
  MODERATION_CLIENT_SCOPE,
  INVITE_CLIENT_SCOPE,
  TOKEN_REVOKE_SCOPE,
] as const;

export type ClientScope = (typeof CLIENT_SCOPES)[number];
