# Account hub: `account.alummahnow.net`

Status: spec for owner review, 2026-11-08. Nothing here is built yet. The plan is in [PLAN.md](./PLAN.md).

The profile app (`apps/profile`, `profile.auth.alummahnow.net`) becomes **Al Ummah Now Account**: one place to see which account you are using and to manage it, like Google's myaccount. It stays a separate OAuth client Worker in this repo.

Facts below were read from `origin/main` of AlUmmahNowAuth and AlUmmahNow on 2026-11-08, plus AlUmmahNow PRs #441, #444 and #455.

## 1. Today

| Piece | Where | What it does |
|---|---|---|
| Profile app | `apps/profile` (~900 lines plus tests) | OAuth client `109a1087-6626-40f7-8a7f-7f42f83f4f30`, public, no secret. KV sessions (`profile_session` cookie, 7 days). Shows the signed-in email, ID and roles, an account menu, the app launcher (`apps.ts`, `launcher.ts`) and "Your apps". en/ar via `?lang=` and a cookie. No light/dark handling. |
| Hosts | `apps/profile/wrangler.json` (prod, `env.stage`), `wrangler.qa.json` | `profile.auth.alummahnow.net`, `profile.auth.stage.…`, `profile.auth.qa.…` as Worker custom domains. |
| Auth browser session | `apps/auth`, `__session` cookie on the auth host | Multi-account sessions (Lane 1): `browser_sessions` and `account_sessions` in D1. |
| Session APIs (cookie) | `apps/auth/src/routes/session-routes.ts` | `GET /session/accounts`, `POST /session/switch`, `DELETE /session/accounts/:userId`, `DELETE /session/all`, `GET /session/check`, `GET /session/devices`, `DELETE /session/devices/:id`. Rate-limited, CORS by `ALLOWED_ORIGINS`. Hard sign-out revokes tokens. |
| Account APIs (Bearer, user token) | `apps/auth/src/routes/account-routes.ts` | `DELETE /account` (needs `auth_time` within 600 s, RFC 9470 step-up challenge otherwise), `GET /account/export`, `POST /account/sign-out-all` (revocation list, #437). |
| Account picker | `routes/select-account.ts`, `ui/select-account.ts`, `ui/account-switcher.ts` | `prompt=select_account` page and an embeddable switcher. |
| Password change | openauth fork, `PasswordProvider` `/password/change` | Change by emailed code. `onPasswordChanged` revokes every sign-in for that email (#437). |
| Audit | `apps/audit-consumer` → D1 `audit_events` | Indexed on `user_id` and `timestamp` separately. Login, logout, password reset, revoke and admin events. |
| Videos settings | AlUmmahNow `apps/web` | Profile (display name, bio, photo, cover, timezone), channel settings, upload defaults, privacy (Videos data export and erasure, link to the account app via `getAuthProfileUrl()`). |
| Videos erasure | AlUmmahNow `apps/api-videos` `POST /api/privacy/erase` | Resumable. Sends `UserDataErased` to the processor when complete. Accepts any user access token of the issuer. Nothing calls auth `DELETE /account` yet. |

Gaps found on the way, fixed by this work:

- The profile sign-in sends no `state` and no PKCE.
- The profile app never refreshes its access token. Tokens live 15 minutes now (#437), so any server-side API call from it would fail after that.
- `handleAuthorizeRedirect` in `apps/auth/src/router.ts` builds `${PROFILE_APP_URL}/callback`, but `PROFILE_APP_URL` ends in `/`, so the redirect URI becomes `…net//callback`, which is not registered.

## 2. Scope of the hub

### 2.1 In the hub

| Area | Contents | Backed by |
|---|---|---|
| **Home** | Who you're signed in as: name, email, photo or initial. Other signed-in accounts, switch, add another account, sign out of this account, sign out of all accounts. Shortcuts to the sections below. | Browser → auth `/session/*` (exists) |
| **Personal info** | Name. Email, with a verified change. Photo (see question Q1). Language. | New `GET/PATCH /account/profile`, new email-change endpoints |
| **Security** | Change password. Recent activity: sign-ins, sign-outs, password and email changes, devices removed, from `audit_events`. | `/password/change` (exists). New `GET /account/activity` |
| **Devices** | Where you're signed in: device, browser, approximate location from IP, last active, "This device". Remove one device. Sign out of all devices. | `/session/devices` (exists). `POST /account/sign-out-all` (exists) |
| **Connected apps** | Apps holding a sign-in for you (Videos, Studio, TV, admin tools), when they were last used, and **Remove access**. | New `GET /account/apps`, `DELETE /account/apps/:clientId` |
| **Data and privacy** | Download your account data. Links to each app's own data (Videos: export and erase). Delete your account. | `GET /account/export` (exists). Deletion orchestration (§5.4) |
| **Your apps** | The launcher and "Your apps" grid, as today. | `apps.ts` |

### 2.2 Stays in each app

The test: if it is about **who you are and how you sign in**, it belongs in the hub. If it is about **what you do or show in one app**, it stays in that app.

| Stays in `apps/web` (Videos) | Why |
|---|---|
| Public profile: display name, localized names, bio, photo, cover | It is the public page people see on Videos, not the sign-in identity. |
| Channel settings (all of #441) | Per channel, Videos only. |
| Upload defaults, video and playback preferences, timezone | Videos behaviour. |
| Videos data export and erasure | Videos owns that data. The hub links to it and calls it during account deletion. |

`apps/web` keeps its settings pages and adds links to the hub where the topic is account-level (§3.2).

## 3. Naming and copy

### 3.1 The name

The product is **Al Ummah Now Account** (Arabic **حساب الأمة الآن**), short form **Account** (**الحساب**). "Profile" is not used in the hub, because on Videos the profile and channel are the public pages.

| Key | English | Arabic |
|---|---|---|
| Page title | Al Ummah Now Account | حساب الأمة الآن |
| Header app name | Account | الحساب |
| Launcher name | Account | الحساب |
| Launcher description | Your account, security and devices | حسابك وأمانه وأجهزتك |
| Link from other apps | Manage your Account | إدارة حسابك |
| Home | Home | الرئيسية |
| Home greeting | Welcome, {name} | مرحبًا، {name} |
| Home subtitle | Manage your info, security and devices across Al Ummah Now. | أدِر معلوماتك وأمانك وأجهزتك في كل تطبيقات الأمة الآن. |
| Personal info | Personal info | المعلومات الشخصية |
| Name | Name | الاسم |
| Email | Email | البريد الإلكتروني |
| Change email | Change email | تغيير البريد الإلكتروني |
| Email code sent | We sent a code to {email}. | أرسلنا رمزًا إلى {email}. |
| Email changed | Your email is now {email}. Sign in again with it. | أصبح بريدك الإلكتروني {email}. سجّل الدخول به مجددًا. |
| Photo | Photo | الصورة |
| Language | Language | اللغة |
| Security | Security | الأمان |
| Change password | Change password | تغيير كلمة المرور |
| Password note | Changing your password signs you out on all devices. | تغيير كلمة المرور يُخرجك من كل الأجهزة. |
| Recent activity | Recent activity | النشاط الأخير |
| Devices | Devices | الأجهزة |
| This device | This device | هذا الجهاز |
| Remove device | Sign out of this device | تسجيل الخروج من هذا الجهاز |
| Sign out all devices | Sign out of all devices | تسجيل الخروج من كل الأجهزة |
| Connected apps | Connected apps | التطبيقات المتصلة |
| Remove access | Remove access | إزالة الوصول |
| Last used | Last used {time} | آخر استخدام {time} |
| Data and privacy | Data and privacy | البيانات والخصوصية |
| Download data | Download your account data | تنزيل بيانات حسابك |
| App data | Data in Al Ummah Now Videos | بياناتك في فيديوهات الأمة الآن |
| Delete account | Delete your account | حذف حسابك |
| Delete warning | This permanently deletes your account, your channels and your videos. It can't be undone. | يحذف هذا حسابك وقنواتك وفيديوهاتك نهائيًا، ولا يمكن التراجع عنه. |
| Step-up title | Confirm it's you | تأكيد هويتك |
| Step-up body | For your security, sign in again to continue. | لحمايتك، سجّل الدخول مجددًا للمتابعة. |
| Switch account | Switch account | تبديل الحساب |
| Add account | Add another account | إضافة حساب آخر |
| Sign out | Sign out | تسجيل الخروج |
| Sign out all accounts | Sign out of all accounts | تسجيل الخروج من كل الحسابات |
| Your apps | Your apps | تطبيقاتك |
| Signed-out hero | Sign in to manage your Al Ummah Now Account. | سجّل الدخول لإدارة حسابك في الأمة الآن. |

Strings live in `apps/profile/src/i18n.ts`, and a test keeps the en and ar key sets equal. Emails, handles and URLs stay `dir="ltr"` inside Arabic text.

The OAuth client's display name changes from "Auth Profile" to "Al Ummah Now Account" in the migration (§6.2), so it reads correctly on the account picker and in Connected apps.

### 3.2 How `apps/web` links to the hub, and changes to #441 and #444

- **#441 (channel settings, in-place editing): no change.** Channel settings are Videos-only and stay as designed.
- **#444 (profile and account settings headers): three changes before merge.**
  1. The first settings tab is keyed `account` and links to `/settings`. Rename its label from "Account" to **"Overview"** (**نظرة عامة**), so "Account" means only the hub. The key can stay.
  2. In the identity header, add **"Manage your Account"** next to "View profile". It links to `getAuthProfileUrl()` and opens in the same tab. That helper already returns the right host, and it follows the rename in §4.4.
  3. In Profile → Preferences, the email row currently says `emailCannotBeChanged`. Replace that with **"Change it in your Account"** linking to `<account>/personal-info#email`. Show the email from the auth token (`auth.user.email`) first and the profile copy second, because the token is the source of truth once email can change.
- **Privacy page (follow-up PR after hub phase B):** the existing "manage account" link points to `<account>/data`. When the hub ships deletion (phase C), the Videos "Erase my data" section stays for Videos-only erasure, and a "Delete your whole account" link goes to `<account>/data#delete`.
- **Rename in the monorepo (follow-up PR, with phase A):** `AUTH_PROFILE_URL` → `AUTH_ACCOUNT_URL`, `getAuthProfileUrl` → `getAccountUrl`, `deriveAuthProfileUrl` → `deriveAccountUrl`. The derivation changes from `profile.<auth host>` to "replace the leading `auth.` label with `account.`" (`auth.qa.alummahnow.net` → `account.qa.alummahnow.net`). Release E2E `profile-signin.spec.ts` and `targets.ts` move to the new host. `docs/compliance/GDPR.md` names the new host.

## 4. Hosting

### 4.1 Hosts

| Env | New host | Old host | Worker (unchanged) | Config |
|---|---|---|---|---|
| prod | `account.alummahnow.net` | `profile.auth.alummahnow.net` | `al-ummah-now-profile` | `apps/profile/wrangler.json` top level |
| stage | `account.stage.alummahnow.net` | `profile.auth.stage.alummahnow.net` | `al-ummah-now-profile-stage` | `wrangler.json` `env.stage` |
| QA | `account.qa.alummahnow.net` | `profile.auth.qa.alummahnow.net` | `al-ummah-now-profile-qa` | `wrangler.qa.json` |

Each config gets the new host as a second `custom_domain: true` route. `APP_URL` becomes the new host. Both hosts stay on the same Worker. The Worker names, the `apps/profile` directory and the release app id `profile` stay as they are: renaming a Worker creates a new script and breaks version-based rollback, and it shows no user anything. `scripts/release/apps.ts` `allowedHosts` lists both hosts.

### 4.2 Old host

Every request whose `Host` is a `profile.auth.*` host gets a **301 to the same path and query on the new host**, with two exceptions:

- `/logout` on the old host still clears the old `profile_session` cookie and continues the single sign-out chain (`?next=`). An app with a stale `FRONTCHANNEL_LOGOUT_URLS` must not break sign-out.
- `/callback` on the old host redirects to the new host's `/` without the code. The code is single-use and only valid with the old redirect URI. The new host then signs in silently with `prompt=none`, so an in-flight sign-in costs one extra redirect.

The old cookie is host-only on the old host, so it cannot leak to the new host. Users sign in silently once on the new host.

### 4.3 Cookies and session

- Hub session cookie: `__Host-account_session`. Host-only, `Path=/`, `Secure`, `HttpOnly`, `SameSite=Lax`, 7 days. On localhost, `account_session` without the prefix.
- KV session `session:<random>` as today, holding user id, email, roles, access token, refresh token and the access token's `auth_time`. Nothing token-like reaches the browser.
- **Refresh:** before each server-side API call, if the access token expires within 60 s, refresh with the refresh token and store the new pair. A refused refresh (signed out everywhere, password changed, account deleted) deletes the KV session and sends the user to sign in.
- **Following the auth account:** the account you are using is the auth browser session's active account. On every full page load, the hub's script calls `GET /session/check` on auth with credentials. If the active user differs from the hub session's user, or there is none, it re-runs `/authorize?prompt=none`. So switching account anywhere shows up in the hub on the next load.
- **Sign-in flow:** add `state` (random, in a short-lived host-only cookie) and PKCE S256 to every `/authorize` the hub starts. The callback checks both.
- `lang` cookie unchanged.

### 4.4 Auth server and other places that name the profile host

AlUmmahNowAuth:

| File | Change |
|---|---|
| `apps/auth/wrangler.json` (prod, stage), `wrangler.qa.json` | `PROFILE_APP_URL` → new var `ACCOUNT_APP_URL` with the new host, no trailing slash. Code reads `ACCOUNT_APP_URL ?? PROFILE_APP_URL` for one release, then the old var goes. `FRONTCHANNEL_LOGOUT_URLS`: `account.*/logout` replaces `profile.auth.*/logout`. QA `ALLOWED_ORIGINS` gains `https://account.qa.alummahnow.net` (prod `*.alummahnow.net` and stage `*.stage.alummahnow.net` already match). `SIGN_IN_FALLBACK_URL` on stage moves to the new host. |
| `apps/auth/src/router.ts`, `utils/sign-in-restart.ts`, `handlers/logout-handler.ts`, `handlers/session-ui-handlers.ts`, `handlers/account-picker-signout.ts`, `env.d.ts` | Read the new var. Fix the `//callback` join. |
| `apps/admin/app/lib/forbidden.ts` `profileAppUrl` | Derive `account.` from `auth.` as in §3.2. Rename to `accountAppUrl`. |
| `apps/profile/src/apps.ts` | Entry `profile` → name and URLs of §3.1 and §4.1. The id can stay `profile`. |
| `scripts/release/apps.ts`, `scripts/release/smoke.ts`, `scripts/stage/seed.ts` and their tests | New host, plus the old host as a 301 smoke check. Stage seed maps `account.alummahnow.net` → `account.stage.alummahnow.net`. |
| `.github/workflows/qa-e2e.yml`, `release.yml` | `E2E_PROFILE_URL` → `E2E_ACCOUNT_URL` with the new host. Warm-up URL. |
| `e2e/utils/test-data.ts`, `playwright.config.ts`, `README.md`, `CICD.md`, `docs/release-pipeline.md`, `API_REFERENCE.md`, `CONTRIBUTING.md`, `.env.test.example`, `apps/auth/.dev.vars.example`, `apps/auth/README.md` | Host and var names. Archived docs under `apps/auth/docs/` are left alone. |

Other repos (from an org-wide code search for `profile.auth`, `PROFILE_URL`, `PROFILE_APP_URL` and `profile.${`):

| Repo | Files | Change |
|---|---|---|
| AlUmmahNow | `apps/web/src/lib/runtime-config.ts`, `app/layout.tsx`, `PrivacySettingsView.tsx` and tests, `e2e/release/targets.ts`, `e2e/release/profile-signin.spec.ts`, `e2e/release-prod/signed-in.check.ts`, `CLAUDE.md`, `docs/compliance/GDPR.md`, `docs/release-pipeline/SPEC.md` and `PLAN.md` | §3.2 rename and new host |
| AlUmmahNowUI | `src/lib/env.ts`, `scripts/environments.ts`, `scripts/dev-vars.ts`, `wrangler.jsonc`, `.dev.vars.example`, `README.md`, `docs/SPEC.md` | `PROFILE_URL` → `ACCOUNT_URL`, `https://account.${sub}alummahnow.net` |
| AlUmmahNowCMS, Android, Apple, Desktop, Tools, Core, openauth | none found | Re-run the search before phase A merges, because the code search index can lag. |

## 5. Architecture

### 5.1 Shape

The hub stays a **separate OAuth client Worker** in this repo. It is not merged into the auth server: the issuer stays small, its blast radius stays small, and the hub is a client like every other app, so it can only do what its tokens allow.

It is server-rendered HTML with a little script, as today. It reaches auth in two ways:

1. **Browser → auth `/session/*`, with credentials.** These APIs are about the auth browser session (`__session` on the auth host). The hub Worker never sees that cookie, so only the browser can call them. The hub uses them for: accounts list, switch, sign out of one account, sign out of all accounts, devices list and remove. They exist, are rate-limited and are covered by CORS.
2. **Hub Worker → auth `/account/*`, with the user's Bearer access token** from the hub's KV session. Used for everything about the account itself. Pages post forms to the hub, and the hub calls auth server to server.

```text
browser ──(cookie __Host-account_session)──► hub Worker ──(Bearer user token)──► auth /account/*
   │                                                        └──(Bearer)──► api-videos /api/privacy/* (deletion only)
   └──(cookie __session, CORS)──► auth /session/*
```

### 5.2 Auth APIs the hub needs

| API | Exists | Notes |
|---|---|---|
| `GET /session/accounts`, `POST /session/switch`, `DELETE /session/accounts/:id`, `DELETE /session/all`, `GET /session/check` | yes | Browser calls. QA CORS origin added. |
| `GET /session/devices`, `DELETE /session/devices/:id` | yes | Browser calls. `isCurrentSession` already marks this device. |
| `POST /account/sign-out-all` | yes | "Sign out of all devices". |
| `/password/change` (openauth) | yes | Hub links to `<auth>/password/change?redirect_uri=<hub /authorize URL>`, so you come back signed in again. It already signs you out everywhere. |
| `GET /account/export` | yes | Auth data JSON download, proxied by the hub. |
| `DELETE /account` | yes | Step-up already enforced. |
| `GET /account/profile`, `PATCH /account/profile` | **new** | `{ name, email, locale, createdAt }`. PATCH takes `name` (1 to 100 chars, trimmed, no control characters) and `locale` (`en` or `ar`), stored in `users.name` and `users.metadata.locale`. Emits `auth.account.updated`. |
| `POST /account/email/start`, `POST /account/email/confirm` | **new** | §5.3. |
| `GET /account/activity?cursor=` | **new** | The caller's own `audit_events` of a fixed list of types, newest first, 20 per page, last 90 days. Returns time, type, success, coarse device from the user agent, and IP. Never returns metadata as-is. |
| `GET /account/apps`, `DELETE /account/apps/:clientId` | **new** | Clients holding a live refresh token for the user (KV `oauth:refresh` by subject, plus D1 `refresh_tokens`), joined with `oauth_clients` for the name. DELETE removes that client's refresh tokens. Access tokens already issued expire within 15 minutes. The hub's own client is listed but can't be removed from here. |

New endpoints go in `account-routes.ts` next to the existing ones and reuse `verifyUserAccessToken` and `requireRecentSignIn`.

### 5.3 Email change

1. `POST /account/email/start { newEmail }`. Needs a recent sign-in. Normalise and validate the address. Refuse if another live account uses it, but reply the same way as success, so nobody can probe which addresses are taken. Send a 6-digit code to the new address through the existing sender (the QA/stage code sink catches `@e2e.alummahnow.net`). Keep `{ userId, newEmail, codeHash, attempts }` in KV for 15 minutes.
2. `POST /account/email/confirm { code }`. At most 5 attempts. Then:
   - D1 `users.email`, the KV user record and its email index (`createUserService`);
   - move the password credential `['email', old, 'password']` → `['email', new, 'password']`;
   - send a notice to the **old** address;
   - revoke every sign-in (`revokeUser(..., 'email_changed')`, plus the KV refresh tokens), the same as a password change.
   - Emit `auth.account.updated` with `{ field: 'email' }`. The addresses are not stored in the audit event.

Signing out everywhere is deliberate. Tokens carry the email in their properties. The OpenAuth subject may be derived from those properties, so old tokens would otherwise keep the old email until they expire. Signing in again gives every app the new email at once.

Videos keeps a copy of the email on its profile. #444's change (§3.2) shows the token's email. A later Videos change can stop storing the copy.

### 5.4 Account deletion (phase C)

Order matters: app data first, then the sign-in, because once the account is gone its token can't erase anything.

1. Step-up (fresh sign-in).
2. The hub calls api-videos `POST /api/privacy/erase { confirm: "DELETE" }` with the user's token, repeating with `resumeToken` until `complete`. api-videos then sends `UserDataErased` to the processor, as it does today.
3. The hub calls auth `DELETE /account`, which soft-deletes the user, removes the password and refresh tokens, adds the user to the revocation list and emits `user.deleted`.
4. Sign out and show a confirmation page.

If step 2 fails part-way, nothing in auth is deleted. The page says what happened and can be retried, because erasure is resumable.

### 5.5 Security model

- **Who may call the new endpoints:** user access tokens only (existing `verifyUserAccessToken`). The write endpoints (`PATCH /account/profile`, email change, `DELETE /account/apps/:id`) also require the token's `aud` to be the hub client, from a new var `ACCOUNT_CLIENT_ID`. A compromised or buggy app token then cannot change someone's email. The read endpoints, export, sign-out-all and delete stay open to any first-party user token, as today, because native apps use them.
- **Scopes:** tokens carry no useful scope claim today, so the audience check above is the control. A scope such as `account:manage` can replace it once scopes are enforced (Lane 4).
- **Re-authentication:** a sign-in within 600 s (`auth_time`, the existing `REAUTH_MAX_AGE_SECONDS`) is required for email change, removing a connected app and deleting the account. Password change verifies by code anyway. On the 401 `insufficient_user_authentication`, the hub shows "Confirm it's you" and sends you to `/authorize?prompt=login&max_age=0`. It comes back to the same page with the form still to submit. The hub never replays the action automatically.
- **CSRF:** hub forms post to the hub with a per-session CSRF token (random, in the KV session, in a hidden field) and an `Origin` check. The session cookie is `SameSite=Lax`. Browser calls to `/session/*` need a CORS preflight (DELETE, or POST with JSON), and auth allows only listed origins.
- **Rate limits** (existing `rateLimit` middleware, keyed by user id): profile PATCH 10/min. Email start 3/hour and 10/day, plus a limit per target address. Email confirm 5 tries per code. Activity 30/min. Apps DELETE 10/min. The hub also limits its form posts per session.
- **Headers:** strict CSP with a nonce for the inline script, `frame-ancestors 'none'`, `Referrer-Policy: same-origin`, and `Cache-Control: no-store` on signed-in pages.
- **Audit:** every change through the hub emits an audit event with `initiatedBy: 'self'` and `clientId`. Those events are what Recent activity shows.

## 6. Data changes and migrations

### 6.1 Schema

- **No new tables.** Language goes in `users.metadata` (JSON) as `locale`. Pending email changes live in KV with a TTL.
- **Index** `idx_audit_events_user_time ON audit_events(user_id, timestamp)` for the activity query. This is expand-only.

### 6.2 Migrations (both `migrations/` and `migrations-qa/`, append-only)

| File | Prod and stage (`migrations/`) | QA (`migrations-qa/`) |
|---|---|---|
| `0014_account_hub_client.sql` | `UPDATE oauth_clients SET name = 'Al Ummah Now Account', redirect_uris = '["http://localhost:3302/callback","https://account.alummahnow.net/callback","https://profile.auth.alummahnow.net/callback"]', updated_at = … WHERE id = '109a1087-…'` | Same, with `account.qa.` and `profile.auth.qa.` |
| `0015_audit_events_user_time.sql` | the index | the index |
| `0016_drop_profile_redirect_uris.sql` (phase C, after the old host has only redirected for a full release) | old redirect URI removed | same |

Stage replays `migrations/`, and `scripts/stage/seed.ts` rewrites the hosts, so it needs the new mapping. Regenerate `schema.snapshot.sql` and `schema.qa.snapshot.sql` (CI fails if stale). `CLIENT_REGISTRY_MODE` is `enforce`, so 0014 must run before the hub uses the new redirect URI. `release.yml` migrates before it deploys candidates, so shipping both in one PR is safe.

## 7. Theming

The hub follows [THEMES.md](https://github.com/Al-Ummah-Now/AlUmmahNow/blob/main/docs/design/THEMES.md) (row "Profile": Worker, HTML strings, generated CSS module, `ACTIVE_THEME` in `vars`).

- `ACTIVE_THEME` in each wrangler config's `vars` (`lantern` everywhere at first). The build runs `fanous-tokens build --theme $ACTIVE_THEME --app profile --out apps/profile/src/generated/` (gitignored). The CSS is inlined as a string module.
- Light and dark from `prefers-color-scheme` in the generated CSS. No toggle and no script, so nothing flashes on load.
- Pages use only component tokens (`--fanous-c-nav-*`, `button.*`, `form.*`, `card.*`, `tabs.*`, `menu.*`, `dialog.*`, `toast.*`, `link.text`, `divider.line`, `skeleton.*`, `empty.*`). No hex, `rgb()` or palette literals: the 55 hard-coded hex lines in `apps/profile/src` go to zero. `check:theme-colors` runs with an empty allowlist for this app.
- Logo, wordmark, favicon and `themeColor` come from the theme slots.
- The theme matrix (each registered theme × light/dark × en/ar) runs a smoke page and axe on Home and Security.

How tokens reach this repo depends on how the theme package ships (THEMES §"Across repos": `@al-ummah-now/fanous-themes` on GitHub Packages). Until it is published, the hub vendors the Lantern generated CSS from a pinned monorepo commit, with a CI check that the copy matches the pin.

## 8. Tests

| Level | What |
|---|---|
| Unit (`apps/profile`, vitest pool workers) | Old-host 301 rules, including the `/logout` and `/callback` exceptions. Cookie attributes. State and PKCE checks. Refresh-before-call and refused-refresh handling. CSRF token and Origin check. Step-up 401 → re-auth redirect. Launcher catalog with the new host. en/ar key parity. No colour literals. |
| Unit and API (`apps/auth`) | Each new endpoint: own data only, the hub-audience rule on writes, step-up, rate limits, audit event emitted, input validation. Email change: taken address answers like success, code expiry, attempt cap, password credential moved, old-address notice, revocation. Connected apps: only the user's clients, the hub not removable, refresh tokens gone in KV and D1. Activity: type allowlist, 90-day window, cursor, no metadata leak. Fix for the `//callback` join. |
| Migrations | The existing migration checks, snapshot regeneration, stage seed mapping test. |
| E2E on QA (`e2e/tests/account/`, Playwright) | Old host → new host. Sign up and sign in. Two accounts: switch, sign out one, sign out all. Remove a second device (second browser context). Sign out of all devices. Password change and email change through the `@e2e.alummahnow.net` code sink. Export download. Step-up prompt. Remove a connected app, then that app has to sign in again. Every page in en and ar, light and dark, with axe. |
| Release | `scripts/release/smoke.ts`: new host 200, old host 301, client redirect URI registered. AlUmmahNow release E2E sign-in on the new host. |

## 9. Release

- **This repo:** every merge to `main` goes through `release.yml`: build once, stage (deploy, smoke, E2E), then production through Workers versions (0% candidate with version-override smoke, 100%, smoke, automatic rollback). There are no manual deploys. PRs are tested on QA by `qa-e2e.yml`.
- **AlUmmahNow:** production ships only from a `v*` tag on `main` through `release.yml`. The web follow-ups (§3.2) go out in the next tag after the hub is live on prod.
- **Order:** (1) auth and hub phase A merge, released to stage, then prod. (2) AlUmmahNow and AlUmmahNowUI rename PRs, so their links go straight to the new host instead of through the 301. (3) Later phases.
- Rollback of phase A is safe: the old host is still a route of the same Worker, and the old redirect URI stays registered until 0016.

## 10. Phasing

| Phase | Ships | New auth APIs |
|---|---|---|
| **A: move and rename** (first release) | New hosts, old-host 301, naming and copy, the client migration, state and PKCE, token refresh, the theme and light/dark rebuild of the existing pages. Home (who you are, switch, add, sign out one/all), Devices (list, remove, sign out of all devices), Change password (link to the existing flow), Download account data, Your apps. Personal info read-only. All links in every repo. | None. Only config, the migration, the `ACCOUNT_APP_URL` var and the `//callback` fix. |
| **B: manage** | Name and language editing, email change, Recent activity, Connected apps. #444 follow-up links. | `/account/profile`, `/account/email/*`, `/account/activity`, `/account/apps` |
| **C: data and photo** | Account deletion orchestration, account photo (if Q1 says so), migration 0016, removal of the `PROFILE_APP_URL` fallback. | None, or an upload endpoint for Q1 |

Phase A changes no auth behaviour, so it can ship as soon as it is reviewed. Each later phase is a separate PR series.

## 11. Open questions for the owner

1. **Photo.** (a) The hub shows your Videos profile photo and links to Videos to change it. Auth stores no photo. (b) Auth owns one account photo that every app uses by default, which needs image storage in auth. **Recommendation: (a)** until a second product needs a photo.
2. **Email change signs you out everywhere**, the same as a password change (§5.3). Is that acceptable? The alternative is weeks of stale emails in tokens and more code.
3. **Deletion lives in the hub** and deletes everything: Videos content, then the account (§5.4). Videos keeps its own "erase my Videos data" option. Agree?
4. **Old host lifetime.** Keep the `profile.auth.*` 301 permanently (it costs nothing), or remove the routes after 90 days? **Recommendation: permanent.**
