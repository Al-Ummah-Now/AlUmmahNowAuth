# docs/plans Review

## Findings
- **High – Session APIs depend on missing helpers** (`docs/plans/LANE-3-SESSION-MANAGEMENT-APIS.md`): routes call `getAccountSessionByUserId` and `getAccountsForBrowserSession`, but these methods are not defined in the Lane 1 services. Implementations will fail/compile-break when the session routes try to revoke tokens or list sessions. Add these helpers (or adjust callers) before coding begins.
- **High – Tenant isolation not enforced on sessions/cookies** (`docs/plans/LANE-1-MULTI-ACCOUNT-SESSIONS.md`, `docs/plans/LANE-5-MULTI-TENANT.md`): browser sessions are created without a required tenant and `getBrowserSessionByToken` never checks tenant. The `__session` cookie is global, so a login on tenant A can be replayed on tenant B (custom domains/subdomains), breaking tenant isolation and enabling cross-tenant SSO/admin actions. Plan to bind browser/account sessions to the resolved tenant (cookie scoping, DB filters) and reject mismatched tenants.
- **High – Tenant scoping helper uses string interpolation** (`docs/plans/LANE-5-MULTI-TENANT.md` → tenant-query.ts): `withTenantScope` inlines `tenant_id` directly into SQL and rewrites the query text. This is injection-prone (Host header→tenant slug→SQL) and brittle with existing WHERE/ORDER/LIMIT clauses. Use parameter binding and explicit tenant predicates in each query instead of string substitution.
- **Medium – Sliding-window semantics conflict** (`docs/plans/LANE-1-MULTI-ACCOUNT-SESSIONS.md` vs `docs/plans/LANE-4-TOKEN-ARCHITECTURE.md`): Lane 1 `touchBrowserSession` only updates `last_activity`, but Lane 4 describes extending `expires_at` on each touch (sliding window). Inconsistent behaviour will cause sessions to expire unexpectedly or never expire depending on which code path lands in prod. Align on one policy and implement it in the shared service.
- **Medium – Max-account check ignores expiration** (`docs/plans/LANE-1-MULTI-ACCOUNT-SESSIONS.md`): `addAccountToSession` counts all non-revoked rows without filtering `expires_at`, so expired sessions still block new logins (max 3) until cleanup. Filter on `expires_at > now` or purge expired rows before enforcing the limit.
- **Medium – Authorize route references undefined dependency** (`docs/plans/LANE-2-SSO-OIDC-PARAMETERS.md`): `/authorize` uses `generateAuthorizationCode(...)` but the plan doesn’t specify where it comes from/imported. As written it will not compile. Clarify whether this is an OpenAuth helper or a new local function and include its signature/flow.

## Recommendations
- Add the missing session helpers (or adjust the routes) before starting Lane 3 to avoid blocking basic logout flows.
- Make tenant context part of session creation/lookup and scope cookies per-tenant domain/subdomain; reject token/session reuse across tenants.
- Replace the string-based tenant scoping helper with parameterised queries; avoid relying on text replacement to inject tenant predicates.
- Decide on sliding-window rules and apply them consistently in `touchBrowserSession` and cleanup jobs.
- Include `expires_at` in account-count queries so the 3-account cap can’t be hit by stale sessions.
- Specify or stub `generateAuthorizationCode` (or equivalent OpenAuth hook) in the authorize route plan.
