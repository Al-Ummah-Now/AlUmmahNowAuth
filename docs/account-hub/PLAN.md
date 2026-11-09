# Account hub: plan

Implements [SPEC.md](./SPEC.md). Nothing starts until the owner has reviewed the spec and read its §11 owner decisions (all answered). Migrations start at 0015 in both directories (SPEC §6.2, `migrations-qa/0014` is taken). Every step follows SPEC §0: auth and the hub never call, read or import a consuming app. Each step is one PR that leaves prod working, merges only when CI is green, and is merged with `gh pr merge --rebase --admin`. Auth PRs reach prod through `release.yml` on merge. AlUmmahNow PRs reach prod in the next `v*` tag.

| Step | Repo | Title | Depends on |
|---|---|---|---|
| 0 | auth | Spec and plan | (this PR) |
| A1 | auth | `account.*` redirect route, client name migration, `//callback` fix, smoke | 0 approved |
| A2 | auth | Hub sign-in hardening: state, PKCE, token refresh, `__Host-` cookie, CSRF helper, CSP | A1 |
| A3 | auth | Hub UI rebuild on theme tokens, light/dark, Account naming, Home, Devices, Security (password link), Data (export), Your apps | A2, theme tokens available (SPEC §7) |
| A4 | AlUmmahNow | #444 wording changes (SPEC §3.2). No host or variable rename | A3 |
| B1 | auth | `GET/PATCH /account/profile`, `ACCOUNT_CLIENT_ID` audience rule, rate limits | A3 |
| B3 | auth | `/account/activity` and migration 0016 | B1 |
| B4 | auth | `/account/apps` list and remove | B1 |
| B4b | auth | Launcher and privacy links from the client registry (`/account/launcher`, migration 0017), `apps.ts` removed | B1 |
| B5 | auth | Hub pages for B1–B4b, step-up flow | B1–B4b |
| B6 | AlUmmahNow | Privacy page link to `<account>/data`. #444 read-only email explanation and link to `<account>/personal-info#email` | B5 live on prod |
| C1 | auth | Account events: `account-events` queue, signed SETs to subscribed clients, retry and DLQ | B5 |
| C2 | auth | Deletion in the hub: auth `DELETE /account` plus the `account.deleted` event | C1 (Q3 decided: apps delete everything) |
| C3 | AlUmmahNow | Videos receiver: verify the SET, erase on `account.deleted` with its own queue. Then auth migration 0018 subscribes Videos | C1 on QA |
| T1 | auth | QA-only migration removing the theme demo redirect URIs from #249 | Theme demos torn down (any time, independent of the hub) |

---

## A1: `account.*` redirect

Scope:
- `apps/profile/wrangler.json`: add `account.alummahnow.net` (top level) and `account.stage.alummahnow.net` (`env.stage`) as `custom_domain: true` routes. `wrangler.qa.json`: add `account.qa.alummahnow.net`. Add `REDIRECT_HOSTS` with that env's `account.*` host. The `profile.auth.*` routes and `APP_URL` are unchanged.
- `apps/profile/src/index.ts`: as the first line of `fetch`, a `Host` in `REDIRECT_HOSTS` gets `301` to `APP_URL` plus the same path and query, with `Cache-Control: max-age=3600`. Nothing else: no session, no KV, no cookie (SPEC §4.2).
- Migration `0015_account_hub_client_name.sql` in `migrations/` and `migrations-qa/`: client display name only, `redirect_uris` untouched.
- Auth: fix the `//callback` join in `handleAuthorizeRedirect`. No var changes: `PROFILE_APP_URL`, `ALLOWED_ORIGINS` and `FRONTCHANNEL_LOGOUT_URLS` stay as they are.
- `scripts/release/apps.ts` (`allowedHosts` gains each env's `account.*`), `smoke.ts` (`account.*` 301 with path and query preserved, `profile.auth.*` 200), and a mention in `docs/release-pipeline.md` and `README.md`.
- If the owner prefers a Cloudflare redirect rule (SPEC §4.2 alternative), this step adds only the smoke check, and the rule and DNS are set by hand per env.

Acceptance:
- Unit: every method and path on an `account.*` host returns 301 to `profile.auth.*` with the path and query preserved, sets no cookie and never reads KV. `profile.auth.*` behaves as before.
- On QA, `https://account.qa.alummahnow.net/x/y?lang=ar` answers 301 to `https://profile.auth.qa.alummahnow.net/x/y?lang=ar`.
- `auth.qa…/authorize` with no params lands on the hub's sign-in (the `//callback` bug is gone, proven by a unit test).
- The config check and the migration checks pass. After release, the smoke check passes on stage and prod for both hosts.

## A2: sign-in hardening

Scope:
- `state` cookie (host-only, 10 minutes) and PKCE S256 on every `/authorize` the hub builds, in both the server and the inline script. The callback checks them.
- Refresh before server-side calls (SPEC §4.3). A refused refresh clears the session.
- Store `auth_time` from the access token in the session.
- Cookie `__Host-account_session` (no prefix on localhost). An existing `profile_session` is carried over once, then cleared, so nobody is signed out.
- `src/security.ts`: CSRF token in the session plus a hidden field, an `Origin` check for POSTs, the CSP nonce, `no-store` and the other SPEC §5.5 headers.
- `/session/check` sync on page load (SPEC §4.3).
- Remove the E2E-only `/revoke` endpoint, or keep it only where `APP_ENV` is not `production`, as the auth test routes do.

Acceptance:
- Unit tests: a missing or wrong `state` is refused, the PKCE verifier is sent on exchange, an expiring token is refreshed once, a refused refresh signs out, a cross-origin POST is refused, and the cookie attributes are as specified.
- E2E: after switching account on auth, a reload of the hub shows the new account.

## A3: hub UI, phase A content

Scope:
- Split `page.ts` into one module per page: `pages/home.ts`, `pages/devices.ts`, `pages/security.ts`, `pages/data.ts`, `pages/personal-info.ts` (read-only), with a shared `layout.ts` (header with launcher and account menu, section nav, footer). Routes `/`, `/personal-info`, `/security`, `/devices`, `/data`, `/apps`.
- Copy from SPEC §3.1 in `i18n.ts`, plus an en/ar key-parity test.
- Initials avatar (SPEC §2.3) from the session's name or email, with the `avatar.*` token part. If the part is missing, a small fanous-tokens PR in AlUmmahNow adds it first. No photo anywhere.
- The dependency-rule test (SPEC §8), with `apps.ts` as its one allowed exception until B4b.
- Theme: `ACTIVE_THEME` var and the build step that writes `src/generated/theme.css`, imported as text. Until `@al-ummah-now/fanous-themes` is published, vendor Lantern's generated CSS at a pinned monorepo commit with a pin check. Component tokens only. `check:theme-colors` with an empty allowlist for `apps/profile`.
- Devices page through browser calls to `/session/devices` (list, remove) and the hub's `POST /devices/sign-out-all` → auth `POST /account/sign-out-all`.
- Security: "Change password" → `<auth>/password/change?redirect_uri=<hub authorize URL>`, with the note that it signs you out everywhere.
- Data: "Download your account data" → hub `GET /data/export` streams auth `GET /account/export`. No app links yet (they come from the registry in B4b).
- Before and after screenshots: desktop and 390 px, en and ar, light and dark, every page.

Acceptance:
- E2E on QA (`e2e/tests/account/`): sign in, switch between two accounts, sign out one and then all, remove a second browser context's device, sign out of all devices, password change via the code sink, export download. Every page passes axe in en and ar, in light and dark.
- No colour literals in `apps/profile/src`, enforced by CI.
- Owner approves the screenshots before merge (visual change).

## A4: #444 wording

Scope: the three #444 changes in SPEC §3.2 (the "Overview" tab label, "Manage your Account" linking to `getAuthProfileUrl()`, and the read-only email explanation). No host or variable rename anywhere: links keep `profile.auth.*`. Either #444 takes the changes before it merges, or A4 applies them right after #444 merges, whichever comes first.

Acceptance: web unit tests for the new labels and links in en and ar.

## B1: profile endpoint and the audience rule

Scope:
- `GET /account/profile` and `PATCH /account/profile` in `account-routes.ts`, routed in `router.ts`.
- `ACCOUNT_CLIENT_ID` var (equal to `PROFILE_CLIENT_ID`) and a `requireHubClient(user)` guard for write endpoints.
- Per-user rate limits (SPEC §5.5). Audit `auth.account.updated`.
- The auth sign-in UI and email templates use `users.metadata.locale` as the default when there is no `?lang=`. (Small, and in the same PR so the preference has an effect.)

Acceptance: API tests for own-data-only, a write with another client's token refused (403), validation, the rate limit, and the audit event.

## B3: activity

Scope: migration `0016_audit_events_user_time.sql` in both directories plus the snapshots. `GET /account/activity` with a type allowlist, a 90-day window, a cursor on `(timestamp, id)`, and coarse user-agent parsing. Nothing from `metadata` is returned unless allowlisted.

Acceptance: API tests for the allowlist, the window, paging, and other users' events never returned. Query plan uses the new index (checked in the test with `EXPLAIN QUERY PLAN`).

## B4: connected apps

Scope: list clients from the user's refresh tokens (KV by subject, D1 `refresh_tokens`) joined with `oauth_clients`. The DELETE removes that client's tokens in both stores and emits `auth.token.revoke` with `{ clientId, initiatedBy: 'self' }`. The hub's own client can't be removed. Before coding, confirm that KV refresh token values carry `clientID`. If they don't, the list comes from `account_sessions.client_id` and D1 only, and the spec is updated.

Acceptance: API tests. E2E: after removing Videos QA, its next refresh fails and it asks you to sign in.

## B4b: launcher and privacy links from the registry

Scope: migration `0017_client_registry_metadata.sql` in both directories, setting `metadata.launcher` and `privacy_url` for the current first-party clients with per-env URLs. Stage seed rewrites the hosts. `GET /account/launcher` filters by the caller's roles with the same `normalizeRole` rule as today. The hub renders the launcher, "Your apps" and the Data page's "Manage your data in {app}" links from it. `apps.ts` and its tests are deleted, and the dependency-rule test drops its exception. Auth admin can edit these metadata fields.

Acceptance: the launcher on QA matches today's per role (a test with the old catalog as the fixture). Adding a client with launcher metadata shows it with no hub change. No app hostname is left in `apps/profile/src`.

## B5: hub pages for phase B

Scope: editable name and language, the read-only email with the SPEC §5.3 explanation and "Create a new account" button, Recent activity, the Connected apps page, and the "Confirm it's you" step-up page (SPEC §5.5) with return to the pending form.

Acceptance: E2E for each flow in en and ar, axe, screenshots approved.

## C1: account events

Scope (SPEC §5.4): an `account-events` queue (`-qa`, `-stage`) and a producer binding in auth, with the same name in every env. A consumer in auth reads `oauth_clients.metadata.events`, builds a SET (RFC 8417) signed with the active JWKS key, and POSTs it (RFC 8935) through the existing webhook sink with retry and the `webhook_dlq`. Event types: RISC `account-purged` for `account.deleted`, no other types for now. The payload carries only the subject. The queue is added to the config check and to `release.yml` like the audit consumer.

Acceptance: unit tests (signature verifies with the JWKS, no email in the payload, unsubscribed clients get nothing, a 5xx endpoint retries and then lands in the DLQ, DLQ replay works). On QA, a test receiver subscribed through a QA-only migration row gets the event.

## C2: deletion in the hub

Scope: the confirmation page (type the confirmation word, step-up), then auth `DELETE /account`, which now also enqueues `account.deleted`. Then sign out and the confirmation page from SPEC §3.1. The hub calls nothing but auth.

Acceptance: QA E2E: a throwaway account is deleted, signing in with it fails, and the QA test receiver gets `account-purged` for its subject. A unit test checks that `DELETE /account` returns before delivery and still succeeds when every subscriber is down.

## C3: Videos receiver (AlUmmahNow)

Scope (Q3: Videos deletes all of the user's data): an endpoint in api-videos that verifies the SET against auth's JWKS (issuer and audience = Videos' client id), is idempotent on `jti`, and enqueues erasure on Videos' own queue. A worker runs the existing resumable `eraseUserData` to completion and sends `UserDataErased`. Then auth migration `0018_client_event_subscriptions.sql` subscribes Videos per env.

Acceptance (AlUmmahNow tests): a signed fixture event erases a seeded user's data, a replayed `jti` is a no-op, a bad signature is refused. QA E2E across both repos: delete in the hub, and the channel is gone on Videos QA shortly after.

## T1: remove the theme demo redirect URIs

Scope: `migrations-qa/NNNN_drop_theme_demo_redirect_uris.sql`, where NNNN is the next number free in both directories at that time (`migrations/` skips it). It removes from the QA videos web client exactly the `https://theme-demo-*.mahmoud-s-darwish.workers.dev/...` URIs that `0014_theme_demo_redirect_uris.sql` added, filtering the JSON array so every other URI stays. Regenerate `schema.qa.snapshot.sql` if the snapshot includes data.

Acceptance: after it runs on QA, `/authorize` with a theme demo redirect URI is refused, and videos QA sign-in still works on all four callback variants.

## Risks

| Risk | Mitigation |
|---|---|
| The `account.*` redirect drifts or breaks in one env | It is a wrangler route in every env, unit-tested and checked by release smoke on stage and prod. |
| A user loses the mailbox of an account before moving their data | No auth recovery, by design (SPEC §5.3). The app holding the data recovers it (Videos: super admin channel transfer, AlUmmahNow #460). |
| Theme package not yet published | Vendored pinned CSS with a pin check (A3). |
| An app misses the deletion event | Delivery retries, then the DLQ with replay. The app's tokens for the user are already refused by the revocation list, so missed clean-up never lets anyone act as the user. |
| A new site needs to appear in the hub | Registry metadata only (B4b). No hub or auth code change, by design (SPEC §0). |
