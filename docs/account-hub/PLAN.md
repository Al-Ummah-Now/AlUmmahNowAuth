# Account hub: plan

Implements [SPEC.md](./SPEC.md). Nothing starts until the owner has reviewed the spec and answered its §11 questions. Each step is one PR that leaves prod working, merges only when CI is green, and is merged with `gh pr merge --rebase --admin`. Auth PRs reach prod through `release.yml` on merge. AlUmmahNow PRs reach prod in the next `v*` tag.

| Step | Repo | Title | Depends on |
|---|---|---|---|
| 0 | auth | Spec and plan | (this PR) |
| A1 | auth | Hosts, old-host redirect, client migration, `ACCOUNT_APP_URL`, link updates in this repo | 0 approved |
| A2 | auth | Hub sign-in hardening: state, PKCE, token refresh, `__Host-` cookie, CSRF helper, CSP | A1 |
| A3 | auth | Hub UI rebuild on theme tokens, light/dark, Account naming, Home, Devices, Security (password link), Data (export), Your apps | A2, theme tokens available (SPEC §7) |
| A4 | AlUmmahNow | `AUTH_ACCOUNT_URL` rename and new derivation, release E2E host, docs. #444 copy changes | A1 live on prod |
| A5 | AlUmmahNowUI | `ACCOUNT_URL` rename and new host | A1 live on prod |
| B1 | auth | `GET/PATCH /account/profile`, `ACCOUNT_CLIENT_ID` audience rule, rate limits | A3 |
| B2 | auth | Email change endpoints | B1 |
| B3 | auth | `/account/activity` and migration 0015 | B1 |
| B4 | auth | `/account/apps` list and remove | B1 |
| B5 | auth | Hub pages for B1–B4, step-up flow | B1–B4 |
| B6 | AlUmmahNow | Privacy page link to `<account>/data`. #444 email link to `<account>/personal-info#email` | B5 live on prod |
| C1 | auth | Deletion orchestration in the hub | B5, Q3 answered |
| C2 | auth | Migration 0016 (drop old redirect URIs), remove `PROFILE_APP_URL` fallback | A1 plus one full release |
| C3 | auth | Account photo | Q1 answered (b) only |

---

## A1: hosts and redirect

Scope:
- `apps/profile/wrangler.json`: add the `account.alummahnow.net` route (top level) and `account.stage.alummahnow.net` (`env.stage`). `wrangler.qa.json`: add `account.qa.alummahnow.net`. Keep the `profile.auth.*` routes. Set `APP_URL` to the new host.
- `apps/profile/src/index.ts`: old-host handling (SPEC §4.2): 301 to the same path on the new host, except `/logout` (handled in place) and `/callback` (to `/` on the new host). Read the old hosts from `APP_URL` and one new var, `LEGACY_HOSTS`, so nothing is inferred.
- Migrations `0014_account_hub_client.sql` in `migrations/` and `migrations-qa/` (SPEC §6.2). Regenerate both schema snapshots.
- `scripts/stage/seed.ts`: map `account.alummahnow.net` → `account.stage.alummahnow.net`, and test it.
- Auth: new var `ACCOUNT_APP_URL` in all three envs. The code reads `ACCOUNT_APP_URL ?? PROFILE_APP_URL`. Fix the `//callback` join in `handleAuthorizeRedirect`. Update `FRONTCHANNEL_LOGOUT_URLS`, QA `ALLOWED_ORIGINS` and stage `SIGN_IN_FALLBACK_URL`. Add `ACCOUNT_APP_URL` to the config check's required vars.
- `apps/admin/app/lib/forbidden.ts`: `accountAppUrl` derives `account.` from `auth.`.
- `apps/profile/src/apps.ts`: launcher entry URLs.
- `scripts/release/apps.ts` (both hosts in `allowedHosts`), `smoke.ts` (new host 200, old host 301, client check on the new redirect URI), `qa-e2e.yml` and `release.yml` (`E2E_ACCOUNT_URL`), E2E utils, and the docs listed in SPEC §4.4.

Acceptance:
- On QA, `https://account.qa.alummahnow.net/` signs in and shows the account. `https://profile.auth.qa.alummahnow.net/x?y=1` answers 301 to `https://account.qa.alummahnow.net/x?y=1`. Signing out from Videos QA still clears the hub session.
- `auth.qa…/authorize` with no params lands on the hub's sign-in (the `//callback` bug is gone, proven by a unit test).
- The config check and the migration checks pass, and the stage seed test covers the new host.
- After release, prod smoke passes on both hosts.

## A2: sign-in hardening

Scope:
- `state` cookie (host-only, 10 minutes) and PKCE S256 on every `/authorize` the hub builds, in both the server and the inline script. The callback checks them.
- Refresh before server-side calls (SPEC §4.3). A refused refresh clears the session.
- Store `auth_time` from the access token in the session.
- Cookie `__Host-account_session` (no prefix on localhost). The old `profile_session` cookie is cleared if present.
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
- Theme: `ACTIVE_THEME` var and the build step that writes `src/generated/theme.css`, imported as text. Until `@al-ummah-now/fanous-themes` is published, vendor Lantern's generated CSS at a pinned monorepo commit with a pin check. Component tokens only. `check:theme-colors` with an empty allowlist for `apps/profile`.
- Devices page through browser calls to `/session/devices` (list, remove) and the hub's `POST /devices/sign-out-all` → auth `POST /account/sign-out-all`.
- Security: "Change password" → `<auth>/password/change?redirect_uri=<hub authorize URL>`, with the note that it signs you out everywhere.
- Data: "Download your account data" → hub `GET /data/export` streams auth `GET /account/export`. A link to Videos privacy settings.
- Before and after screenshots: desktop and 390 px, en and ar, light and dark, every page.

Acceptance:
- E2E on QA (`e2e/tests/account/`): sign in, switch between two accounts, sign out one and then all, remove a second browser context's device, sign out of all devices, password change via the code sink, export download. Every page passes axe in en and ar, in light and dark.
- No colour literals in `apps/profile/src`, enforced by CI.
- Owner approves the screenshots before merge (visual change).

## A4 and A5: links in other repos

Scope: SPEC §3.2 and the §4.4 "Other repos" table. Re-run the org code search first, and add anything new to the PR. For #444: either it takes the three changes before it merges, or A4 applies them right after #444 merges, whichever comes first.

Acceptance: no `profile.auth` left outside archived docs. AlUmmahNow release E2E signs in on `account.qa`. The UI repo builds with the new var.

## B1: profile endpoint and the audience rule

Scope:
- `GET /account/profile` and `PATCH /account/profile` in `account-routes.ts`, routed in `router.ts`.
- `ACCOUNT_CLIENT_ID` var (equal to `PROFILE_CLIENT_ID`) and a `requireHubClient(user)` guard for write endpoints.
- Per-user rate limits (SPEC §5.5). Audit `auth.account.updated`.
- The auth sign-in UI and email templates use `users.metadata.locale` as the default when there is no `?lang=`. (Small, and in the same PR so the preference has an effect.)

Acceptance: API tests for own-data-only, a write with another client's token refused (403), validation, the rate limit, and the audit event.

## B2: email change

Scope: SPEC §5.3. `POST /account/email/start` and `/confirm`. KV pending state, code hashing with the existing helpers, the sender with an en/ar template, the old-address notice, moving the password credential, `revokeUser(..., 'email_changed')` (add the reason to the union), and the audit event.

Acceptance:
- API tests: step-up required, a taken address answers like success but sends no code, the code expires, the attempt cap holds, after confirm the old email cannot sign in and the new one can with the same password, and every earlier token is rejected.
- QA E2E through the code sink.

## B3: activity

Scope: migration `0015_audit_events_user_time.sql` in both directories plus the snapshots. `GET /account/activity` with a type allowlist, a 90-day window, a cursor on `(timestamp, id)`, and coarse user-agent parsing. Nothing from `metadata` is returned unless allowlisted.

Acceptance: API tests for the allowlist, the window, paging, and other users' events never returned. Query plan uses the new index (checked in the test with `EXPLAIN QUERY PLAN`).

## B4: connected apps

Scope: list clients from the user's refresh tokens (KV by subject, D1 `refresh_tokens`) joined with `oauth_clients`. The DELETE removes that client's tokens in both stores and emits `auth.token.revoke` with `{ clientId, initiatedBy: 'self' }`. The hub's own client can't be removed. Before coding, confirm that KV refresh token values carry `clientID`. If they don't, the list comes from `account_sessions.client_id` and D1 only, and the spec is updated.

Acceptance: API tests. E2E: after removing Videos QA, its next refresh fails and it asks you to sign in.

## B5: hub pages for phase B

Scope: editable name and language, the email change flow, Recent activity, the Connected apps page, and the "Confirm it's you" step-up page (SPEC §5.5) with return to the pending form.

Acceptance: E2E for each flow in en and ar, axe, screenshots approved.

## C1: deletion

Scope: SPEC §5.4 orchestration in the hub. The confirmation page needs you to type the confirmation word and passes step-up. Erase Videos data with resume, then delete in auth, sign out, then the confirmation page. The api-videos base URL comes from a per-env var. The failure page offers a retry.

Acceptance: QA E2E: a throwaway account with a channel and a video is deleted, its Videos data is gone, and signing in with it fails. A unit test checks that auth delete never runs when erasure did not complete.

## C2: cleanup

Scope: migration `0016_drop_profile_redirect_uris.sql` in both directories, removal of the `PROFILE_APP_URL` fallback and var, and smoke updated (the old host is still a 301 if Q4 says permanent).

## Risks

| Risk | Mitigation |
|---|---|
| Old-host sessions are lost at cutover | A silent `prompt=none` sign-in on the new host. Nothing for the user to do. |
| A stale front-channel logout URL in some app | The old host still serves `/logout` (SPEC §4.2). |
| The OpenAuth subject changes with the email | Email change revokes by user id through the revocation list, which does not depend on the subject. Covered by a B2 test. |
| Theme package not yet published | Vendored pinned CSS with a pin check (A3). |
| Deletion half-done | Auth delete only after erasure is complete. Erasure is resumable. |
