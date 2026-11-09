# Account hub: `account.alummahnow.net`

Status: spec for owner review, 2026-11-08. Nothing here is built yet. The plan is in [PLAN.md](./PLAN.md).

The profile app (`apps/profile`, `profile.auth.alummahnow.net`) becomes **Al Ummah Now Account**: one place to see which account you are using and to manage it, like Google's myaccount. It stays a separate OAuth client Worker in this repo.

Facts below were read from `origin/main` of AlUmmahNowAuth and AlUmmahNow on 2026-11-08, plus AlUmmahNow PRs #441, #444 and #455.

## 0. Architectural rule: auth depends on no app

**The auth server and the account hub never depend on the apps that use them** (Videos, www, CMS, admin tools, native apps, any future site). Apps depend on auth, never the reverse. Auth is an SSO provider that can be split out and used by other sites.

In practice:

- Neither auth nor the hub calls an app's API, reads an app's database, queue or KV, or imports an app's code or types.
- Neither stores or serves app data, such as a photo, a display name or a channel.
- Neither hard-codes an app's name or URL in code. When the hub needs to show an app (connected apps, the launcher, a privacy link), it reads that from auth's own **client registry** (`oauth_clients` and its `metadata`), which each app's registration fills in as data.
- When an app must react to something in auth (account deleted), auth **publishes an event** to apps that subscribed through their client registration (§5.4). Auth never waits for the result, and each app does its own clean-up.
- Configuration that names an app's URL purely to send the browser there is allowed (a redirect URI, a front-channel logout URL). These are generic OIDC mechanisms, filled in per client, and auth works if an app is missing.

Every section below has been checked against this rule. §12 lists what it changed.

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
| **Home** | Who you're signed in as: initials avatar, name, email. Other signed-in accounts, switch, add another account, sign out of this account, sign out of all accounts. Shortcuts to the sections below. | Browser → auth `/session/*` (exists) |
| **Personal info** | Name. Email, read-only and permanent (§5.3). Language. No photo (§2.3). | New `GET/PATCH /account/profile` |
| **Security** | Change password. Recent activity: sign-ins, sign-outs, password changes, devices removed, from `audit_events`. | `/password/change` (exists). New `GET /account/activity` |
| **Devices** | Where you're signed in: device, browser, approximate location from IP, last active, "This device". Remove one device. Sign out of all devices. | `/session/devices` (exists). `POST /account/sign-out-all` (exists) |
| **Connected apps** | Apps holding a sign-in for you, when they were last used, and **Remove access**. Names, icons and links come from the client registry, not from the apps. | New `GET /account/apps`, `DELETE /account/apps/:clientId` |
| **Data and privacy** | Download your account data (auth's data only). For each connected app that registered a `privacy_url`, a link "Manage your data in {app}". Delete your account. | `GET /account/export` (exists). Deletion with events (§5.4) |
| **Your apps** | The launcher and "Your apps" grid. | Phase A: the existing `apps.ts` catalog, a known exception to §0. Phase B: client registry metadata (§5.2) |

### 2.2 Stays in each app

The test: if it is about **who you are and how you sign in**, it belongs in the hub. If it is about **what you do or show in one app**, it stays in that app.

| Stays in `apps/web` (Videos) | Why |
|---|---|
| Public profile: display name, localized names, bio, photo, cover | It is the public page people see on Videos, not the sign-in identity. |
| Channel settings (all of #441) | Per channel, Videos only. |
| Upload defaults, video and playback preferences, timezone | Videos behaviour. |
| Videos data export and erasure | Videos owns that data. The hub links to it through Videos' registered `privacy_url` and never calls it. On account deletion, Videos erases its data when it receives auth's event (§5.4). |

`apps/web` keeps its settings pages and adds links to the hub where the topic is account-level (§3.2).

### 2.3 Photo: none in auth (owner decision, 2026-11-08)

- The auth server stores and serves **no profile photo** and issues **no `picture` claim**.
- The hub shows an **initials avatar**: the first letter of the name, or of the email's local part when there is no name. It takes the first grapheme (`Intl.Segmenter`), so Arabic and combined characters work, and it is upper-cased where the script has case. Colours come from theme tokens, an `avatar.*` component part (background, text). If `tokens/components.json` has no such part yet, it is added in the tokens package with the usual contrast checks. That is a design-system change, not a dependency on any app.
- Videos keeps its own profile photo and channel photos, unchanged. The hub **never reads from Videos**, neither its API nor its database.
- **Possible later addition:** an optional account-wide photo served by a **separate profile service** (Graph-style), which apps may choose to use. It would never be in the SSO tokens or the auth server, and it is not planned.

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
| Email permanent | Your email can't be changed. | لا يمكن تغيير بريدك الإلكتروني. |
| Different email | To use a different email, create a new account and move your channels to it. | لاستخدام بريد إلكتروني آخر، أنشئ حسابًا جديدًا وانقل قنواتك إليه. |
| Create account | Create a new account | إنشاء حساب جديد |
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
| App data | Manage your data in {app} | إدارة بياناتك في {app} |
| Delete account | Delete your account | حذف حسابك |
| Delete warning | This permanently deletes your account. The apps you used with it are told, and each deletes the data it holds for you. It can't be undone. | يحذف هذا حسابك نهائيًا. وتُبلَّغ التطبيقات التي استخدمتها به، فيحذف كلٌّ منها بياناتك لديه. ولا يمكن التراجع عن ذلك. |
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
  3. In Profile → Preferences, the email row stays read-only, because email is permanent (§5.3). Keep `emailCannotBeChanged` and add the same explanation as the hub ("To use a different email, create a new account and move your channels to it.") with a link to `<account>/personal-info#email`. Show the email from the auth token (`auth.user.email`), because auth is its source.
- **Privacy page (follow-up PR after hub phase B):** the existing "manage account" link points to `<account>/data`. When the hub ships deletion (phase C), the Videos "Erase my data" section stays for Videos-only erasure, and a "Delete your whole account" link goes to `<account>/data#delete`.
- **Client registration (phase B):** Videos fills in its registry metadata (launcher name, icon, URL, `privacy_url`), and in phase C its event subscription (§5.4). That is how Videos appears in the hub without the hub knowing about Videos.
- **Photo:** none of this changes Videos' own profile and channel photos (§2.3).
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
   └──(cookie __session, CORS)──► auth /session/*

auth ──(signed event, to subscribed clients only)──► each app's own endpoint   (§5.4)
```

The hub talks only to auth. Neither the hub nor auth calls any app's API.

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
| `GET /account/activity?cursor=` | **new** | The caller's own `audit_events` of a fixed list of types, newest first, 20 per page, last 90 days. Returns time, type, success, coarse device from the user agent, and IP. Never returns metadata as-is. |
| `GET /account/apps`, `DELETE /account/apps/:clientId` | **new** | Clients holding a live refresh token for the user (KV `oauth:refresh` by subject, plus D1 `refresh_tokens`), joined with `oauth_clients` for name, icon and `privacy_url`. Only auth's own data, no call to any app. DELETE removes that client's refresh tokens. Access tokens already issued expire within 15 minutes. The hub's own client is listed but can't be removed from here. |
| `GET /account/launcher` | **new** (phase B) | The launcher list, from `oauth_clients.metadata.launcher` (`name` en/ar, `description` en/ar, `icon`, `url`, `category`, `requiredRoles`), filtered by the caller's roles. It replaces the hard-coded `apps.ts` catalog, so adding a site is a registry change with no hub code. Registry fields are set through auth admin or a migration, per environment. |

New endpoints go in `account-routes.ts` next to the existing ones and reuse `verifyUserAccessToken` and `requireRecentSignIn`.

### 5.3 Email is permanent (owner decision, 2026-11-08)

**Nobody can change an account's email: not the hub, not the auth server, not any app.** There is no email-change API, flow or event.

- To use a different email, the user creates a new account with it. Multi-account sessions already let one browser hold both accounts and switch between them. The user then moves their data across **in each app**, using that app's own tools (for Videos, moving channels). The hub does not move anything, because auth never depends on apps (§0).
- **Personal info** shows the email read-only, with the explanation from §3.1 and a **Create a new account** button. The button starts the generic add-account flow (`/authorize?prompt=select_account`, then "use another account" to sign up), the same as the account menu's "Add another account".
- The hub links into no app from here. If an app later wants its "move your data" page linked, it registers that URL in its own client-registry metadata, and the hub lists it next to that app's `privacy_url` links. The hub never hard-codes it.
- This removes a whole class of problems: no moving password credentials between email keys, no OpenAuth subject change, no stale emails in tokens, and no email copies in apps going out of date.

**Edge case: the old email is lost before moving.** The password reset sends its code to the account's email. Someone who has lost that mailbox can't reset the password, so they can't sign in to move their data. Auth offers no recovery that changes the email. Recovery is in the app that holds the data: for Videos, a super admin transfers the channel to the user's new account (AlUmmahNow spec PR #460, super admin channel claim and transfer). The old account stays as it is, or its owner deletes it if they still can.

### 5.4 Account deletion and account events (phase C)

**Changed from the first draft.** The first draft had the hub call Videos' erase API, then auth. That broke §0. Now auth only deletes its own data and publishes an event. Each app cleans up its own data.

**Deletion:**

1. Step-up (fresh sign-in) on the hub's confirmation page.
2. The hub calls auth `DELETE /account` (exists). Auth soft-deletes the user, removes the password and refresh tokens, adds the user to the revocation list, and emits `user.deleted` to the audit queue, as it already does.
3. Auth publishes the event `account.deleted` (below).
4. The hub signs out and shows a confirmation page: your account is deleted, and the apps you used have been told to delete their data.

Auth does not wait for apps and does not know whether they have finished. Each app's handling is that app's own concern. For Videos: a handler in api-videos receives `account.deleted`, then runs its existing resumable erasure (`eraseUserData`) as a background job on its own queue, and sends `UserDataErased` to its processor as it does today. That work is planned in the AlUmmahNow repo, not here.

The revocation list already makes every token of the deleted user fail at the APIs that check it (api-videos does), so nothing can act for the user while the apps clean up.

**Account events: how auth tells apps, without depending on them.**

- **Subscription is registry data.** A client opts in with `oauth_clients.metadata.events = { "uri": "https://…", "types": ["account.deleted"] }`. Auth has no list of apps in its code. An unsubscribed or missing app changes nothing for auth.
- **Format:** a Security Event Token (RFC 8417), signed with auth's own keys (JWKS), so the app verifies it the same way it verifies access tokens. Deletion uses the RISC `account-purged` event type, with the subject as `iss_sub`. More types can be added later the same way. The payload carries only the user id, never an email or a name.
- **Delivery:** push by `POST` (RFC 8935) from a new auth queue, `account-events`, using the existing webhook sink with retry and dead-letter queue (`webhook_dlq`, ADR-001), which the admin DLQ routes can replay. The delete request only enqueues, so a slow or down app never blocks or breaks auth.
- **Why not the audit queue directly:** `audit_events` is auth's internal log, and its schema is not a contract. Apps must not consume it. The audit queue still records the event.
- **Why not Videos' `UserDataErased`:** that is a message on Videos' own queue. Auth sending to it would be auth depending on Videos. Videos turns `account.deleted` into its own `UserDataErased`.

### 5.5 Security model

- **Who may call the new endpoints:** user access tokens only (existing `verifyUserAccessToken`). The write endpoints (`PATCH /account/profile`, `DELETE /account/apps/:id`) also require the token's `aud` to be the hub client, from a new var `ACCOUNT_CLIENT_ID`. A compromised or buggy app token then cannot rename someone or cut off their other apps. The read endpoints, export, sign-out-all and delete stay open to any first-party user token, as today, because native apps use them.
- **Scopes:** tokens carry no useful scope claim today, so the audience check above is the control. A scope such as `account:manage` can replace it once scopes are enforced (Lane 4).
- **Re-authentication:** a sign-in within 600 s (`auth_time`, the existing `REAUTH_MAX_AGE_SECONDS`) is required for removing a connected app and deleting the account. Password change verifies by code anyway. On the 401 `insufficient_user_authentication`, the hub shows "Confirm it's you" and sends you to `/authorize?prompt=login&max_age=0`. It comes back to the same page with the form still to submit. The hub never replays the action automatically.
- **CSRF:** hub forms post to the hub with a per-session CSRF token (random, in the KV session, in a hidden field) and an `Origin` check. The session cookie is `SameSite=Lax`. Browser calls to `/session/*` need a CORS preflight (DELETE, or POST with JSON), and auth allows only listed origins.
- **Rate limits** (existing `rateLimit` middleware, keyed by user id): profile PATCH 10/min. Activity 30/min. Apps DELETE 10/min. The hub also limits its form posts per session.
- **Headers:** strict CSP with a nonce for the inline script, `frame-ancestors 'none'`, `Referrer-Policy: same-origin`, and `Cache-Control: no-store` on signed-in pages.
- **Audit:** every change through the hub emits an audit event with `initiatedBy: 'self'` and `clientId`. Those events are what Recent activity shows.

## 6. Data changes and migrations

### 6.1 Schema

- **No new tables.** Language goes in `users.metadata` (JSON) as `locale`. Launcher entries, `privacy_url` and event subscriptions go in `oauth_clients.metadata` (JSON). The current clients are filled in by migration, per environment.
- **No photo column or storage** (§2.3).
- New queue `account-events` (and `-qa`, `-stage`) for event delivery (§5.4), with the same binding name in every env, as the config check requires.
- **Index** `idx_audit_events_user_time ON audit_events(user_id, timestamp)` for the activity query. This is expand-only.

### 6.2 Migrations (both `migrations/` and `migrations-qa/`, append-only)

Numbering: AlUmmahNowAuth #249 already took `migrations-qa/0014_theme_demo_redirect_uris.sql`, a temporary QA-only redirect for the theme demo sites. This work therefore starts at **0015 in both directories**. `migrations/` leaves 0014 unused, so each file below has the same number in both directories, as the plan assumes. Any later QA-only or prod-only migration takes the next number free in **both** directories, and the other directory skips it.

| File | Prod and stage (`migrations/`) | QA (`migrations-qa/`) |
|---|---|---|
| `0015_account_hub_client.sql` | `UPDATE oauth_clients SET name = 'Al Ummah Now Account', redirect_uris = '["http://localhost:3302/callback","https://account.alummahnow.net/callback","https://profile.auth.alummahnow.net/callback"]', updated_at = … WHERE id = '109a1087-…'` | Same, with `account.qa.` and `profile.auth.qa.` |
| `0016_audit_events_user_time.sql` | the index | the index |
| `0017_client_registry_metadata.sql` (phase B) | `metadata.launcher` and `privacy_url` for the current first-party clients, prod URLs | same, with QA URLs |
| `0018_client_event_subscriptions.sql` (phase C, once an app has an endpoint) | `metadata.events` for subscribing clients | same |
| `0019_drop_profile_redirect_uris.sql` (phase C, after the old host has only redirected for a full release) | old redirect URI removed | same |
| `NNNN_drop_theme_demo_redirect_uris.sql` (when the theme demos are torn down; next number free in both directories) | none (prod skips the number) | removes the `theme-demo-*` URIs that `0014_theme_demo_redirect_uris.sql` added to the QA web client, keeping every other URI |

Stage replays `migrations/`, and `scripts/stage/seed.ts` rewrites the hosts, so it needs the new mapping. Regenerate `schema.snapshot.sql` and `schema.qa.snapshot.sql` (CI fails if stale). `CLIENT_REGISTRY_MODE` is `enforce`, so 0015 must run before the hub uses the new redirect URI. `release.yml` migrates before it deploys candidates, so shipping both in one PR is safe.

## 7. Theming

The hub follows [THEMES.md](https://github.com/Al-Ummah-Now/AlUmmahNow/blob/main/docs/design/THEMES.md) (row "Profile": Worker, HTML strings, generated CSS module, `ACTIVE_THEME` in `vars`).

- `ACTIVE_THEME` in each wrangler config's `vars` (`lantern` everywhere at first). The build runs `fanous-tokens build --theme $ACTIVE_THEME --app profile --out apps/profile/src/generated/` (gitignored). The CSS is inlined as a string module.
- Light and dark from `prefers-color-scheme` in the generated CSS. No toggle and no script, so nothing flashes on load.
- Pages use only component tokens (`--fanous-c-nav-*`, `button.*`, `form.*`, `card.*`, `tabs.*`, `menu.*`, `dialog.*`, `toast.*`, `link.text`, `divider.line`, `skeleton.*`, `empty.*`). No hex, `rgb()` or palette literals: the 55 hard-coded hex lines in `apps/profile/src` go to zero. `check:theme-colors` runs with an empty allowlist for this app.
- Logo, wordmark, favicon and `themeColor` come from the theme slots.
- The initials avatar (§2.3) uses the `avatar.*` component part in both modes. No image is loaded for it.
- The theme matrix (each registered theme × light/dark × en/ar) runs a smoke page and axe on Home and Security.

How tokens reach this repo depends on how the theme package ships (THEMES §"Across repos": `@al-ummah-now/fanous-themes` on GitHub Packages). Until it is published, the hub vendors the Lantern generated CSS from a pinned monorepo commit, with a CI check that the copy matches the pin.

## 8. Tests

| Level | What |
|---|---|
| Unit (`apps/profile`, vitest pool workers) | Old-host 301 rules, including the `/logout` and `/callback` exceptions. Cookie attributes. State and PKCE checks. Refresh-before-call and refused-refresh handling. CSRF token and Origin check. Step-up 401 → re-auth redirect. Launcher catalog with the new host. en/ar key parity. No colour literals. Initials: name, email fallback, Arabic and combined first grapheme. **Dependency rule:** a test fails if `apps/profile/src` or `apps/auth/src` contains an app hostname (`videos.`, `www.`, `cms.`, `admin.alummahnow`) outside wrangler config, `apps.ts` (until phase B removes it) and test fixtures. |
| Unit and API (`apps/auth`) | Each new endpoint: own data only, the hub-audience rule on writes, step-up, rate limits, audit event emitted, input validation. Launcher: built from registry metadata, filtered by role. Account events: a signed SET verifiable with the JWKS, the payload carries no email, only subscribed clients receive it, a failing endpoint lands in the DLQ, and `DELETE /account` returns without waiting for delivery. No route or registry event type changes an email (a test asserts there is none). Connected apps: only the user's clients, the hub not removable, refresh tokens gone in KV and D1. Activity: type allowlist, 90-day window, cursor, no metadata leak. Fix for the `//callback` join. |
| Migrations | The existing migration checks, snapshot regeneration, stage seed mapping test. |
| E2E on QA (`e2e/tests/account/`, Playwright) | Old host → new host. Sign up and sign in. Two accounts: switch, sign out one, sign out all. Remove a second device (second browser context). Sign out of all devices. Password change through the `@e2e.alummahnow.net` code sink. Personal info shows the email read-only and "Create a new account" starts the add-account flow. Export download. Step-up prompt. Remove a connected app, then that app has to sign in again. Delete an account: a test receiver subscribed on QA gets a valid `account-purged` SET. Every page in en and ar, light and dark, with axe. That Videos then erases its data is tested in the AlUmmahNow repo, not here. |
| Release | `scripts/release/smoke.ts`: new host 200, old host 301, client redirect URI registered. AlUmmahNow release E2E sign-in on the new host. |

## 9. Release

- **This repo:** every merge to `main` goes through `release.yml`: build once, stage (deploy, smoke, E2E), then production through Workers versions (0% candidate with version-override smoke, 100%, smoke, automatic rollback). There are no manual deploys. PRs are tested on QA by `qa-e2e.yml`.
- **AlUmmahNow:** production ships only from a `v*` tag on `main` through `release.yml`. The web follow-ups (§3.2) go out in the next tag after the hub is live on prod.
- **Order:** (1) auth and hub phase A merge, released to stage, then prod. (2) AlUmmahNow and AlUmmahNowUI rename PRs, so their links go straight to the new host instead of through the 301. (3) Later phases.
- Rollback of phase A is safe: the old host is still a route of the same Worker, and the old redirect URI stays registered until 0019.

## 10. Phasing

| Phase | Ships | New auth APIs |
|---|---|---|
| **A: move and rename** (first release) | New hosts, old-host 301, naming and copy, the client migration, state and PKCE, token refresh, the theme and light/dark rebuild of the existing pages, the initials avatar. Home (who you are, switch, add, sign out one/all), Devices (list, remove, sign out of all devices), Change password (link to the existing flow), Download account data, Your apps. Personal info read-only, with the permanent-email explanation and "Create a new account" (§5.3). All links in every repo. | None. Only config, the migration, the `ACCOUNT_APP_URL` var and the `//callback` fix. |
| **B: manage** | Name and language editing, Recent activity, Connected apps, the launcher and privacy links from the client registry (`apps.ts` removed). #444 follow-up links. | `/account/profile`, `/account/activity`, `/account/apps`, `/account/launcher` |
| **C: deletion and events** | Account events (`account-events` queue, SETs to subscribed clients), deletion in the hub (auth data plus an event), migrations 0018 and 0019, removal of the `PROFILE_APP_URL` fallback. In AlUmmahNow: the Videos receiver that erases on `account.deleted`. | Event delivery. No new public endpoint. |

Phase A changes no auth behaviour, so it can ship as soon as it is reviewed. Each later phase is a separate PR series.

## 11. Open questions for the owner

1. ~~**Photo.**~~ **Answered 2026-11-08: no photo in auth** (§2.3). The hub shows initials and never reads from Videos.
2. ~~**Email change signs you out everywhere.**~~ **Answered 2026-11-08: email is permanent**, so there is no email change (§5.3).
3. ~~**Deletion scope.**~~ **Answered 2026-11-08: yes.** When an account is deleted, every app subscribed to `account.deleted` deletes all of that user's data on its side. For Videos, that means channels, videos and everything else it holds. The event model in §5.4 is unchanged: auth deletes its own data and publishes the event, and each app does its own clean-up. Videos keeps its own "erase my Videos data" option for erasing Videos data without deleting the account.
4. **Old host lifetime.** Keep the `profile.auth.*` 301 permanently (it costs nothing), or remove the routes after 90 days? **Recommendation: permanent.**

## 12. Changes after owner review (2026-11-08)

- **New §0 rule:** auth and the hub never depend on consuming apps.
- **Photo (Q1):** no photo in auth and no `picture` claim. The hub shows an initials avatar themed with tokens. Videos photos are unchanged. A separate profile service is noted as a possible later addition (§2.3).
- **Deletion redesigned (§5.4):** the hub no longer calls Videos' erase API. Auth deletes its own data and publishes a signed `account.deleted` event to subscribed clients. Each app, Videos included, erases its own data.
- **Launcher and app links:** the hard-coded `apps.ts` catalog (which names Videos, www, CMS and admin URLs) is a phase A exception and is replaced in phase B by client registry metadata. The Videos-specific "data in Videos" link and delete warning became generic.
- **Connected apps:** checked, and already compliant. It reads only auth's own refresh tokens and client registry.
- **Migrations renumbered:** `migrations-qa/0014` is taken by the theme demo redirect (#249), so this work starts at 0015 in both directories: 0015 hub client, 0016 audit index, 0017 registry metadata, 0018 event subscriptions, 0019 drop the old redirect URI. A QA-only migration removes the theme demo URIs when the demos are torn down.
- **Email events:** with email permanent, no `account.email_changed` event exists. `account.deleted` is the only event type.
- **Email is permanent (Q2):** email change is removed everywhere: the `/account/email/*` APIs, its flow, rate limits, KV state, copy, tests and the `identifier-changed` event. Personal info shows the email read-only with "create a new account and move your channels" and the generic add-account flow. Losing the old mailbox is recovered in the app that holds the data (Videos: super admin channel transfer, AlUmmahNow #460), never by auth.
- **Deletion scope (Q3):** decided as everywhere. Every subscribed app deletes all of the user's data when it receives `account.deleted`. Subscribing to the event commits an app to that. The event model is unchanged.
