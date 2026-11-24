# API versioning and deprecation

How the auth server's HTTP interface changes without breaking the apps that use it. The `@al-ummah-now/openauth` package has its own versions ([RELEASING.md](https://github.com/Al-Ummah-Now/openauth/blob/master/docs/RELEASING.md)): breaking → major, new → minor, fix → patch.

**There are no version numbers in the URLs.** The interface is OAuth 2.0 and OpenID Connect plus our own JSON routes, and it only grows. A change that would break a client is made as a new route or parameter, and the old one goes through the deprecation steps below.

## Who depends on what

| Audience | Interface | Slowest client to update |
|---|---|---|
| `public` | Discovery documents, keys, `/authorize`, `/token`, `/logout` and the other OAuth endpoints, the claims inside tokens | Anything that speaks OAuth, and installed native apps |
| `app` | Routes our own apps and servers call: `/account*`, `/session/*`, `/passkeys/*`, `/provisioning/*`, `/moderation/*`, revocation, `/themes*` | Installed native apps: a person may not update for months |
| `admin` | `/admin/*` | The admin dashboard, deployed together with the server, and other admin tools |

`openapi.json` marks each operation with its audience. The fourth one, `page`, is for pages this server shows in a browser: they are not an interface, and the check below leaves them out.

## What breaks a client

Breaking:

- removing or renaming a route, parameter, response field, claim, error code or supported grant, scope or method;
- changing the type, format, unit or meaning of one;
- making an optional parameter required, or accepting fewer values;
- asking for more rights, or a stricter check, on an existing route;
- changing a status code or redirect target that clients act on;
- changing the issuer URL, `sub` values, the signing algorithm or the key set's address.

Not breaking, and allowed at any time:

- a new route, optional parameter, response field, claim or error description;
- a new value in a list that clients are told to treat as open (roles, scopes, error codes);
- a shorter access token lifetime, because clients must refresh when a token is refused or about to expire;
- signing key rotation inside the published overlap;
- new limits on request rate, answered with `429` and `Retry-After`.

Clients must ignore fields and claims they don't know.

**Security comes first.** A hole may be closed at once, even if that breaks a client. The release notes say so, and affected apps are fixed first where possible.

## Deprecating something

1. **Add the replacement** and move every client we own to it.
2. **Announce it** in the release notes and the [wiki changelog](https://github.com/Al-Ummah-Now/AlUmmahNowWiki/blob/main/guides/changelog.md), and mark the operation, parameter or field `deprecated: true` in `openapi.json`, with the removal date as `x-sunset: YYYY-MM-DD` and a pointer to the replacement in its description.
3. **Send the headers** on every answer of the old route:

   ```
   Deprecation: @1796083200
   Sunset: Tue, 01 Jun 2027 00:00:00 GMT
   Link: <https://…>; rel="deprecation"
   ```

   `Deprecation` (RFC 9745) is when it became deprecated, as Unix seconds. `Sunset` (RFC 8594) is the earliest removal, at least the notice below. A deprecated claim or field has no header; its notice is steps 2 and 4.
4. **Watch the use** of the old route by client id and native app version in the request logs.
5. **Remove it** after the sunset date, and only when no supported app version still uses it. Until then the date moves.

| Audience | Minimum notice |
|---|---|
| `public` | 6 months |
| `app`, used by installed native apps | 6 months, and the app version that stopped using it is the oldest one still supported |
| `app`, used only by our web apps and servers | 30 days, and one release of each of those apps |
| `admin` | One release |

A removed route answers `410 Gone` with the replacement's name for 6 months. After that it is an ordinary `404`.

## Database and deploys

Every release serves traffic next to the previous one for a moment, and can be rolled back. So migrations only add ([release-pipeline.md](release-pipeline.md)), and a message, cookie or token written by one version must be readable by the version before it. A format change takes two releases: first read both, then write the new one.

## In review

A pull request that removes or narrows something a client uses says which audience it affects, where it was announced and what still calls it.

**CI checks it.** `pnpm check:api` (in the Release Checks of every pull request) compares `openapi.json` with the one in the newest production release record (`vYYYY.MM.DD[.N]`). It fails when:

- something a client uses was removed or narrowed, unless that release already had it marked `deprecated` with an `x-sunset` that has passed;
- a new deprecation has no `x-sunset`, or less notice than its audience is owed: 182 days for `public`, 30 for `app`, none beyond one release for `admin`;
- an announced `x-sunset` moved earlier.

It cannot know which `app` routes installed native apps use, so the 6 months they are owed is for the reviewer to check.

Two things may go ahead at once: closing a security hole, and correcting a spec that was wrong while the server did not change. Put the exact change the check prints into `docs/api-exceptions.json` with a `kind` (`security` or `correction`) and a reason. An entry matches one change only, and can be deleted after the next release.
