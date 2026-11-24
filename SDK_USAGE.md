# Using the client

Our TypeScript client is part of our OpenAuth fork: `@al-ummah-now/openauth/client`. For Python and Go, use a standard OAuth library; tested examples are in the fork's [`examples/client`](https://github.com/Al-Ummah-Now/openauth/tree/master/examples).

## Install

The package is on GitHub Packages. `.npmrc`:

```ini
@al-ummah-now:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

`NODE_AUTH_TOKEN` is a GitHub token with `read:packages`; in CI, `GITHUB_TOKEN`. Never commit one. Pin the exact version: `pnpm add -E @al-ummah-now/openauth`.

## Sign in

```ts
import { createClient } from '@al-ummah-now/openauth/client';

const client = createClient({
	clientID: env.AUTH_CLIENT_ID,
	issuer: 'https://auth.alummahnow.net',
	// Confidential clients only. Never in a browser or an app.
	clientSecret: env.AUTH_CLIENT_SECRET,
});

// Keep challenge (state and verifier) in an HttpOnly cookie until the user is back
const { challenge, url } = await client.authorize(redirectURI, 'code', { pkce: true });

// On the callback
if (params.get('state') !== challenge.state) throw new Error('Not our sign-in');
const exchanged = await client.exchange(params.get('code')!, redirectURI, challenge.verifier);
if (exchanged.err) return signInAgain();
const { access, refresh, expiresIn } = exchanged.tokens;
```

Keep tokens in HttpOnly, Secure, SameSite=Lax cookies or on your server, never in `localStorage`. The profile app is a complete example: [`apps/profile/src/sign-in.ts`](apps/profile/src/sign-in.ts).

## Know who is asking

```ts
import { createSubjects } from '@al-ummah-now/openauth/subject';
import { array, object, string } from 'valibot';

export const subjects = createSubjects({
	user: object({ id: string(), email: string(), roles: array(string()) }),
});

const verified = await client.verify(subjects, accessToken);
if (verified.err || verified.aud !== env.AUTH_CLIENT_ID) return new Response(null, { status: 401 });
const { id, roles } = verified.subject.properties;
```

`verify` checks the signature, issuer and expiry with keys it caches for 10 minutes. It does not check the audience: compare `aud` yourself, with the clients your service accepts. It doesn't read the revocation list either; a service that must refuse a suspended account at once does ([docs/TOKEN_REVOCATIONS.md](docs/TOKEN_REVOCATIONS.md)).

## Refresh

```ts
const next = await client.refresh(refreshToken);
if (next.err) return signInAgain();
// Store both before using either: the old refresh token stops working
save(next.tokens!);
```

Refresh in one place at a time. Two refreshes with one token within two minutes get the same family; later than that it is treated as stolen.

## Servers, TVs and the rest (1.1.0 and up)

```ts
// A server's own token
const own = await client.clientCredentials({ scopes: ['users:read'] });

// A TV: show the code, then wait for the approval
const started = await client.device.start();
if (!started.err) {
	show(started.device.userCode, started.device.verificationURI);
	const approved = await client.device.poll(started.device, { signal });
}

await client.revoke(refreshToken); // end one sign-in
const info = await client.userinfo(subjects.user, accessToken);
```

These four never throw: each answers `{ err }`, an `AuthRequestError` with the OAuth code in `err.error`, `network_error` when the server can't be reached.

## Accounts on this browser

Our web apps show the accounts signed in on the browser with the session routes, from a page on one of our own origins:

```ts
const res = await fetch('https://auth.alummahnow.net/session/accounts', { credentials: 'include' });
const { accounts } = await res.json(); // [] when signed out
```

`POST /session/switch` with `{ "userId" }` changes the active account; then start a sign-in again to get its tokens. The other routes are in [`openapi.json`](openapi.json), tag "Browser session".

## Errors

`exchange`, `refresh` and `verify` answer `{ err }` for a refusal. They throw when the server can't be reached: catch that and answer 503, not 401, so a short outage doesn't sign everyone out.
