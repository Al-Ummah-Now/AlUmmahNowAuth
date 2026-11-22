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
   straight on. After a failure, or on Skip, the card says how to sign in next
   time: "No passkey yet. Next time, sign in with the link we email you, or add
   a password. You can add a passkey any time in Account → Passkeys." (Skip
   then shows it with Continue instead of leaving at once). See "No sign-in
   method yet" below for the card's failure rules;
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
| Unknown link (replaced by a newer email, or purged) | **We can’t use this link**: Sign in if set up, or type the invited address for a new link |

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

## No sign-in method yet

An accepted account whose passkey was skipped or failed has no password and no
passkey. The normal sign-in page never asks it for a password
(`apps/auth/src/sign-in-link/`):

- Once the email is typed (change, blur, or Continue with the password empty)
  the page asks `POST /sign-in/method {email}` → `{ password: boolean }`. With
  no password, the password field, Continue and the footer step aside for:
  "This email has no password yet. Choose how to sign in:"
  - **Email me a sign-in link** (`POST /sign-in/link`, CSRF: the
    `signin_csrf` cookie, `SameSite=Strict`, `Path=/sign-in`). The same
    single-use invite link and the same send rules as "Email me a new link"
    (deliver first, then store the hash; one per invite every 5 minutes; audit
    `user.invite.resent` with `by: sign_in_page`), in its own short email
    ("Your sign-in link"), in the page's language. It signs in like any invite
    link and offers the passkey card again.
  - **Add a password**: `/password/register?…&setup=1`, titled "Add a
    password", with the email filled in. Its emailed code proves the inbox;
    then the password is set and the account signs in (an invited account is
    claimed). That finishes setup: the account has a way in.
- Without JavaScript, a sign-in POST for such an email comes back (still 401)
  with the two options showing.
- **What it reveals**: only whether the email has a password, which the
  sign-in page already said (registering with it answers "email taken"). An
  unknown email and an account with no method get the very same options and
  pages; "Email me a sign-in link" answers the same "Check your inbox" page
  whether or not anything was sent, and looks up and sends after the answer.
  Only invited accounts with an open invite get a link.
- **Limits**: the check, `PASSWORD_IP_LIMITER` per IP and
  `PASSWORD_EMAIL_LIMITER` per email hash; the link, `SEND_CODE_LIMITER` per IP
  and per email hash.

**The passkey card** (after any sign-in, and the invite's):

- After two failures, the second button becomes **Continue without a
  passkey**.
- A failure is not a "no": leaving after a failure never calls
  `/passkeys/prompt/dismiss`, so the card comes back next sign-in. Only a plain
  Not now (Skip) with no failure snoozes it.
- Each failure is audited: `POST /passkeys/prompt/failed {reason}` →
  `passkey.add_failed` with `reason` (failed, cancelled, network, expired) and a
  coarse `browser` and `os` from the User-Agent (no versions, no device
  models). Auth admin shows them on the user's Passkeys page ("Failed passkey
  attempts", local time with zone, UTC on hover) and in Audit logs.

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
| `POST …/:id/resend` | `locale?, video? (object or null), emailCopy?, actor` | `{invite, emailSent}` |
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

### The email's wording (`emailCopy`)

The videos admin edits the invite's wording (videos admin › Settings › Emails › Creator invite; wiki "Email templates"). Create and resend carry it as `emailCopy: { key: 'creator_invite', version, locale, copy }`: the current version's text in the email's one language, with `{name}`, `{email}`, `{channels}`, `{expires}` and (picture description) `{title}` placeholders, filled here in one pass.

- It is used only when `locale` is the invite's language and every field (`INVITE_COPY_FIELDS` in `apps/auth/src/invites/email.ts`) is a non-empty string.
- Otherwise the built-in copy (`BUILT_IN_COPY`, the same words as the admin template's version 1) is sent, and `[invites] Built-in invite copy used` is logged with the reason (`missing`, `locale_mismatch` or `invalid`). It is an emergency default only.
- The builder has a twin in the videos repo (`apps/admin-api/src/lib/email/invite.ts`) for the editor's preview and test email; keep them identical.

Audit events: `user.invited`, `user.invite.resent`, `user.invite.link_created`,
`user.invite.opened`, `user.invite.accepted`, `user.invite.revoked`,
`user.invite.restored`, `user.invite.purge_requested`, `user.invite.purged`.
They can be filtered in the Auth admin's audit log.

On QA and stage, an address at `e2e.alummahnow.net` is not emailed while the
E2E sink is enabled. Its link is kept in KV under `test:invite:<email>` for 10
minutes, like sign-in codes.
