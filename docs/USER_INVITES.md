# Admin invites (pre-provisioned accounts)

An app admin (today: the videos admin, "Invite creator") invites someone by
email. The account exists from that moment, so the app can give it a plan,
channels and anything else keyed by the user id before the person ever signs
in. When they first sign in with that email they land in that account. There
are no extra steps.

```
videos admin-api ── queue ──▶ POST /provisioning/invites (client credentials, invites:provision)
                                   │ users row: status 'invited', metadata.email_verified = false
                                   │ user_invites row: token hash, expiry, who invited
                                   ▼
                         invite email (en + ar) ──▶ GET /invite/:token ── Continue (POST) ──▶ app sign-in
                                                                                              │
                     issuer onSuccess: same email, any method ◀───────────────────────────────┘
                     → claimInvitedAccount: status 'active', email_verified = true, invite accepted
```

## Accounts

- **Ids.** The inviting app mints both ids: `userId` (`usr_` + 32 hex, the
  same shape Auth uses) and `inviteId` (`inv_` + 32 hex). It can therefore write
  everything keyed by the user id at once, without waiting for Auth. `inviteId`
  is also the idempotency key, so a retried create returns the same invite and
  sends no second email.
- **Status.** An invited account is a normal `users` row with `status =
  'invited'`. It shows up in user lists and search. It gets the Member role, as
  after a sign-up. It gets **no tokens** by any route other than the claim: the
  token gate, the refresh check and single sign-on all refuse any status other
  than `active` (`security/account-status.ts`).
- **Claim.** The issuer's `onSuccess` (`handlers/auth-handlers.ts`) looks the
  user up by email, as for every sign-in. If the account is `invited`, it claims
  it: status becomes `active`, `metadata.email_verified` becomes true, and the
  invite becomes accepted (audit `user.invite.accepted`).
- **Roles.** Member always. The app may add roles from the allow-list
  `INVITE_GRANTABLE_ROLES` by name (today only `Scholar` → `role_scholar`),
  sent as `roles: ["Scholar"]`. Privileged roles (Admin, Super Admin,
  Moderator) are refused (`403 role_not_grantable`); a role that does not exist
  yet answers `400 unknown_role`. Every way in proves
  the address: register and forgot-password both send an emailed code, and a
  password can only be set through one of them. So the claim works for whichever
  method the person picks. No second account is ever created for the email:
  `idx_users_tenant_email` is unique, and the create refuses an email that
  already has an account.
- **Email normalisation.** The same rule as sign-in (`D1UserService`): lower
  case and trimmed. Gmail dots and `+tags` count as different addresses,
  exactly as they do when signing in.

## The link

- The token is 32 random bytes. Only its SHA-256 (`user_invites.token_hash`) is
  stored, and it is never logged or audited.
- `GET /invite/:token` shows who the invite is for. It is in English unless the
  URL has `?lang=ar`; Arabic invites get that in the email link. A GET never
  spends the token, because mail scanners open links.
- **Continue** (`POST`) spends the token once (`token_used_at`) and redirects
  to the app's sign-in (`continueUrl`). That URL must be one of our origins
  (`ALLOWED_ORIGINS`), or localhost outside production. Otherwise the default
  sign-in page is used.
- An expired, used, revoked or unknown link shows the same page: "sign in with
  the email the invite was sent to". The link is only a convenience. An expired
  invite can still be claimed by signing in.
- Expiry: `expiresInDays` per invite (1–90). The default is `INVITE_TTL_DAYS`,
  or 14 if that is not set.
- **Resend** makes a new token, emails it and extends the expiry. The old link
  stops working.
- **Copy link**: the app makes a token, shows the link once and sends only the
  hash (`POST …/link {tokenHash}`). That replaces the emailed link.

## Revoke, restore, purge (admin soft delete)

- **Revoke** soft deletes the invite (`deleted_at` / `deleted_by` /
  `deleted_reason`, the same fields as `admin_deletions`). It also soft deletes
  the account if it was never used (status `deleted`). Nothing can claim it
  afterwards, and the email is free for a normal sign-up. An accepted invite
  cannot be revoked; manage the account instead.
- **Restore** brings both back within the 30 days, provided no other account
  has taken the email in the meantime (`409 email_taken`).
- **Delete permanently now** (`{confirm: <email>}`) only sets
  `purge_requested_at`. The item can still be restored until the cleanup runs.
- **Cleanup** runs in the hourly cron (`cron/token-cron.ts` →
  `purgeRevokedInvites`). It handles revoked invites that are 30 or more days
  old, or queued. It deletes the invite and its never-used account (the users
  row and its role links). An account that somehow signed in is kept. Audit
  event: `user.invite.purged`.
- When the admin soft-delete framework (`admin_deletions`, migration 0027) is
  on main, revoked invites can be listed there too. The fields are the same, so
  nothing moves.

## API (client credentials)

The client authenticates with HTTP Basic `client_id:client_secret` and must
hold the `invites:provision` scope. Migration 0030 grants that scope to the
videos admin client `d7464de8-…`. A client sees only its own invites. Writes
are limited by `ADMIN_SENSITIVE_LIMITER` per client, reads by `ADMIN_LIMITER`.

| Call | Body | Answer |
| --- | --- | --- |
| `POST /provisioning/invites` | `inviteId, userId, email, name?, locale (en/ar), note?, expiresInDays?, continueUrl?, details?, roles? (allow-list), sendEmail?, actor{id,email}` | `201 {invite, user, created, emailSent}`; `200` on replay; `409 user_exists {user}` or `already_invited {user, invite}` |
| `GET /provisioning/invites?ids=a,b` | | `{invites}` (status `invited` / `active` / `expired` / `revoked`) |
| `POST …/:id/resend` | `locale?, actor` | `{invite, emailSent}` |
| `POST …/:id/link` | `tokenHash` (hex SHA-256) | `{invite}` |
| `POST …/:id/revoke` | `reason?, actor` | `{invite}` |
| `POST …/:id/restore` | `actor` | `{invite}` (`409 email_taken`) |
| `POST …/:id/purge` | `confirm` (the email), `actor` | `{invite}` |

Audit events: `user.invited`, `user.invite.resent`, `user.invite.link_created`,
`user.invite.opened`, `user.invite.accepted`, `user.invite.revoked`,
`user.invite.restored`, `user.invite.purge_requested`, `user.invite.purged`.
They can be filtered in the Auth admin's audit log.

On QA and stage, an address at `e2e.alummahnow.net` is not emailed while the
E2E sink is enabled. Its link is kept in KV under `test:invite:<email>` for 10
minutes, like sign-in codes.
