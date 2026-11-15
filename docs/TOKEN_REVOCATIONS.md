# Signing out one device or install

Every sign-in of a user can be ended with the user revocation list (`u:<usr_id>`, see
`apps/auth/src/revocation/revocation-list.ts`). These scoped entries end **part** of them
(AlUmmahNow#442, AlUmmahNowAuth#277, #363):

| Key | Ends | Read by |
|---|---|---|
| `s:<sid>` | one browser sign-in | Auth refresh path (D1) and the resource servers (KV) |
| `i:<usr_id>:<install_id>` | one native app install's refresh tokens | Auth refresh path (D1) |
| `c:<usr_id>:<client_id>` | the user's refresh tokens at one client | Auth refresh path (D1) |

A token whose sign-in (`authTime` / `auth_time`) is before the entry's `before` is refused; a
later sign-in on the same device or install works. Rows live in D1 `scoped_revocations`
(migration 0042); `s:` entries are also written to `TOKEN_REVOCATIONS` with the `u:` layout.

## Where the ids come from (openauth ≥ 1.0.56)

- `sid`: every browser sign-in's code, refresh token and access token carry
  `sid = sessionTokenId(browser_session_id, user_id)` (`@al-ummah-now/openauth/session/token-id`).
  Auth computes it from `account_sessions` rows.
- `install_id`: native apps send it on the `authorization_code` exchange at `/token`
  (1-128 of `[A-Za-z0-9._-]`). It is kept on the refresh token and its rotations, never in
  the access token.

## Who writes them

- Admin `DELETE /admin/users/:userId/sessions/:sessionId` and `POST /admin/sessions/bulk-terminate`
  (up to 200 per call; repeat while `remaining` is true): `s:<sid>` plus the browser's account session.
- `POST /internal/token-revocations`, for client apps holding the `tokens:revoke` scope
  (HTTP Basic client authentication, as `/token`; the videos admin M2M client has it):

  ```http
  POST /internal/token-revocations
  Authorization: Basic base64(client_id:client_secret)
  Content-Type: application/json

  { "user_id": "usr_…", "install_id": "ins_…" }   # or { "user_id": "usr_…", "client_id": "…" }
  ```

  `204` on success; `400` invalid body, `401` bad client, `403` missing scope, `429` rate limited.
  Every call is audited (`admin.user.tokens_revoked`, action `client.revoke_install_tokens` /
  `client.revoke_client_tokens`).

## Staff-only clients

The native Admin apps (`apps/auth/src/admin-native-clients.ts`) need a staff role, read from RBAC,
at every refresh. A user who loses the role is signed out of every Admin install at its next refresh.
