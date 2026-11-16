# Admin invites (pre-provisioned accounts)

An app admin (today: the videos admin, "Invite creator") invites someone by
email. The account exists from that moment, so the app can give it a plan,
channels and anything else keyed by the user id before the person ever signs
in. The invite link signs them straight in: no password, no second code, no
"Create account".

```
videos admin-api ── queue ──▶ POST /provisioning/invites (client credentials, invites:provision)
                                   │ users row: status 'invited', metadata.email_verified = false
                                   │ user_invites row: token hash, expiry, who invited
                                   ▼
             invite email ──▶ GET /invite/:token "Your account is ready" ── Continue (POST)
                                   │ spend the token (single use), claim: status 'active', email verified, invite accepted
                                   │ signed in on this browser as the active account (__session); other accounts untouched
                                   ▼
                     "Sign in faster next time": add a passkey, or Skip
                                   ▼
             app sign-in (continueUrl without prompt) ─▶ /authorize ─▶ single sign-on ─▶ app
             (videos: Studio on the invited channel, else the account page, with a first-run welcome)
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
- **Claim.** Normally the invite link's Continue claims it (above). Any other
  sign-in with that email also does: the issuer's `onSuccess`
  (`handlers/auth-handlers.ts`) looks the user up by email, and if the account
  is `invited`, it claims it: status becomes `active`, `metadata.email_verified` becomes true, and the
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

- The token is 32 random bytes (256 bits). Only its SHA-256
  (`user_invites.token_hash`) is stored, and it is never logged or audited.
  The hash stays after the token is spent, so a second click finds its
  invite; `token_used_at` makes it single use.
- Page language: `?lang=en|ar`, else the invite's language. Arabic pages are
  RTL; addresses are isolated (`<bdi dir="ltr">`).
- A GET never spends the token, because mail scanners open links.

### Continue (POST /invite/:token)

Spending the link proves the person reads the invited inbox, the same proof
as an emailed code. So Continue:

1. checks the CSRF token (form field = `invite_csrf` cookie, `SameSite=Strict`,
   `Path=/invite`; an `Origin` header must be ours). A failed check shows the
   page again and does nothing;
2. spends the token atomically (`UPDATE … WHERE token_used_at IS NULL`): of two
   concurrent clicks exactly one signs in, the other sees the used-link page;
3. claims the account (`claimInvitedAccount`: active, email verified, invite
   accepted; audit `user.invite.opened` + `user.invite.accepted` +
   `auth.login.success`) and re-reads it, so a revoke a moment earlier wins;
4. signs the account in on this browser and makes it the **active** account
   (`invites/sign-in.ts`, `amr: ["otp"]`). Other accounts already signed in on
   the browser change nothing: no extra step or warning, they stay signed in,
   and the invite only ever goes to the invited account. Like the issuer's own
   sign-ins, the account joins the browser's existing session when it has a
   valid one (the encrypted, HttpOnly `__session` cookie decrypts and its D1
   row exists); a browser with no session, or one already holding the most
   accounts a session allows (3), gets a new session with only this account;
5. shows "Sign in faster next time" (add a passkey: Face ID, fingerprint,
   screen lock) with **Skip**. Never a password. Browsers without WebAuthn go
   straight on;
6. goes to the app's sign-in (`continueUrl`, minus any `prompt`). The app's
   `/authorize` completes by single sign-on; the issuer's onSuccess runs as for
   any sign-in (account state, current roles).

`continueUrl` must be one of our origins (`ALLOWED_ORIGINS`), or localhost
outside production; otherwise the default sign-in page is used (no open
redirect). Deployed environments refuse the direct sign-in without
`SESSION_SECRET`.

**Already signed in as the invited account** (a used link opened again):
"You're signed in" + Continue.

### A used, expired or withdrawn link

| State | Page |
| --- | --- |
| The account has no password and no passkey (never set up, or skipped the passkey) | **Finish setting up your account** + "Email me a new link" (POST `/invite/:token/send`) |
| The account has a password or a passkey | **You're already set up** + Sign in |
| Revoked invite, or the account suspended/deleted | **This invite was withdrawn**: contact the person who invited you or the team |
| Unknown link (replaced by a newer email, or purged) | **This link doesn't work**: open the newest email, or contact the team |

"Email me a new link" is the admin resend, asked by the invitee: same email,
same audit event (`user.invite.resent`, `by: invitee`), expiry extended. It
emails a fresh single-use link to the invited address only; the page never
shows it. The email is sent first and the new hash stored only after it was
delivered. Limits: one per invite every 5 minutes (any send, admin or
invitee), `SEND_CODE_LIMITER` per IP, and every `/invite/*` request counts
against `PASSWORD_IP_LIMITER` per IP. For an accepted account without a
password or passkey the new link signs in again the same way (the inbox is
still the only way in).

- Expiry: `expiresInDays` per invite (1–90). The default is `INVITE_TTL_DAYS`,
  or 14 if that is not set.
- **Resend** (admin) makes a new token, emails it and extends the expiry. The
  old link then shows "This link doesn't work".
- **Copy link**: the app makes a token, shows the link once and sends only the
  hash (`POST …/link {tokenHash}`). That replaces the emailed link.
- Signing in some other way with the invited email (password reset, passkey)
  still claims the account and spends the link.

## Revoke, restore, purge (admin soft delete)

- **Revoke** soft deletes the invite (`deleted_at` / `deleted_by` /
  `deleted_reason`, the same fields as `admin_deletions`). It also soft deletes
  the account if it was never used (status `deleted`). The link is spent and
  shows "This invite was withdrawn". Nothing can claim it afterwards, and the email is free for a normal sign-up. An accepted invite
  cannot be revoked; manage the account instead.
- **Restore** brings both back within the 30 days (the old link then offers
  "Email me a new link"), provided no other account
  has taken the email in the meantime (`409 email_taken`).
- **Delete permanently now** (`{confirm: <email>}`) only sets
  `purge_requested_at`. The item can still be restored until the cleanup runs.
- **Cleanup** runs in the hourly cron (`cron/token-cron.ts` →
  `purgeRevokedInvites`). It handles revoked invites that are 30 or more days
  old, or queued. It deletes the invite and its never-used account (the users
  row and its role links). An account that somehow signed in is kept. Audit
  event: `user.invite.purged`.
- The unused account goes through the admin soft-delete framework
  (`admin_deletions`, #293). A `user` row is written with the snapshot status
  `invited` and the reason "Invite revoked: …", so the account appears in
  Auth's **Recently deleted**. That cleanup removes everything keyed by the
  user (identities, sessions, codes, the password credential and KV copies).
  Restoring it there brings it back as `invited`, never `active`. Restoring
  the invite removes the deletion row; purging the invite also queues it.

## API (client credentials)

The client authenticates with HTTP Basic `client_id:client_secret` and must
hold the `invites:provision` scope. Migration 0030 grants that scope to the
videos admin client `d7464de8-…`. A client sees only its own invites. Writes
are limited by `ADMIN_SENSITIVE_LIMITER` per client, reads by `ADMIN_LIMITER`.

| Call | Body | Answer |
| --- | --- | --- |
| `POST /provisioning/invites` | `inviteId, userId, email, name?, locale (en/ar), note?, expiresInDays?, continueUrl?, details?, roles? (allow-list), sendEmail?, actor{id,email}` | `201 {invite, user, created, emailSent}`; `200` on replay; `409 user_exists {user}` or `already_invited {user, invite}` |
| `GET /provisioning/invites?ids=a,b` | | `{invites}` (status `invited` / `active` / `expired` / `revoked`) |
| `POST …/:id/resend` | `locale?, video? (object or null), actor` | `{invite, emailSent}` |
| `POST …/:id/link` | `tokenHash` (hex SHA-256) | `{invite}` |
| `POST …/:id/revoke` | `reason?, actor` | `{invite}` |
| `POST …/:id/restore` | `actor` | `{invite}` (`409 email_taken`) |
| `POST …/:id/purge` | `confirm` (the email), `actor` | `{invite}` |

`details` is the caller's own data. The email reads two keys from it:

- `channels: [{ name, action }]`: the channels named in the email.
- `video: { title, channel, imageUrl, urls: { en, ar } }`: a video shown as a 16:9 picture card. It has a play button, the title and the channel, and links to `urls[<email language>]` (the videos admin sends the short link, `alummahnow.link/v/<id>`, with `?lang=ar` for Arabic). Every URL must be https, and `imageUrl` must never expire (the videos admin sends its `/og/v/<id>.jpg`).
  - Email cannot play video, so the card is a picture linking to the watch page.
  - Outlook desktop gets the same picture through VML.
  - The plain-text part gives the title, the channel and the link.
  - The videos admin keeps one video per email language and sends only the video for the language the email is in, never the other language's (owner, 2026-11-16). The card is static: no playable embed and no GIF.
  - A resend may pass `video` again, or `null` to leave the card out. The videos admin reads the video again at every send and sends `null` once it is no longer public.

Audit events: `user.invited`, `user.invite.resent`, `user.invite.link_created`,
`user.invite.opened`, `user.invite.accepted`, `user.invite.revoked`,
`user.invite.restored`, `user.invite.purge_requested`, `user.invite.purged`.
They can be filtered in the Auth admin's audit log.

On QA and stage, an address at `e2e.alummahnow.net` is not emailed while the
E2E sink is enabled. Its link is kept in KV under `test:invite:<email>` for 10
minutes, like sign-in codes.
