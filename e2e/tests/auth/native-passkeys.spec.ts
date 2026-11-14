/**
 * Native passkey sign-in (wiki AUTH-PASSKEYS "Native apps") against a deployed auth server.
 *
 * Plays the Studio app the way iOS/macOS and Windows do: a software authenticator answers with
 * origin https://<RP ID>, so this runs on QA and stage (the release gate), not only locally.
 *
 *   1. sign up through the form (a per-run account the teardown deletes), then the app's
 *      "Sign in another way": /authorize for the Studio client reuses that browser session
 *   2. add a passkey from the app: /native/passkey/register/options + /verify (Bearer)
 *   3. sign in with it: /native/passkey/options + /verify → code → /token with PKCE; amr has "passkey"
 *   4. the challenge is single use
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { register } from '../../fixtures/auth';
import { TEST_URLS, generateTestEmail } from '../../utils/test-data';
import { SoftAuthenticator, b64url, sha256 } from '../../utils/soft-authenticator';

// Signs up with the test password: traces would record it (e2e/utils/secret-input.ts)
test.use({ trace: 'off' });

const AUTH = TEST_URLS.authServer;
const IS_QA = new URL(AUTH).hostname.endsWith('.qa.alummahnow.net');
/** Studio (iOS / Android): QA has its own client ids; stage and local share production's (migration 0013). */
const STUDIO = {
  id: IS_QA ? '45364a42-21f4-4359-a76c-0a1e6615fd7b' : '6f8073c6-754b-4d63-bf80-0546214e0d62',
  redirect: 'alummahnow-studio://auth/callback',
};

const pkce = async () => {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  return { verifier, challenge: b64url(await sha256(new TextEncoder().encode(verifier))) };
};
/** The origin a native app puts in clientDataJSON; the local stack (RP localhost) takes its own origin. */
const nativeOrigin = (rpId: string) => (rpId === 'localhost' ? new URL(AUTH).origin : `https://${rpId}`);
const claims = (jwt: string) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString()) as { amr?: string[]; aud?: unknown };

async function token(request: APIRequestContext, code: string, verifier: string) {
  return request.post(`${AUTH}/token`, {
    form: { grant_type: 'authorization_code', code, client_id: STUDIO.id, code_verifier: verifier, redirect_uri: STUDIO.redirect },
  });
}

test.describe('Native passkey sign-in', () => {
  test.setTimeout(120000);

  test('a native app adds a passkey and signs in with it, no browser', async ({ page, playwright }) => {
    const email = generateTestEmail('native-passkey');
    await register(page, email);

    // "Sign in another way": the system browser already holds the auth session, so /authorize answers with a code
    const first = await pkce();
    const authorize = await page.request.get(
      `${AUTH}/authorize?${new URLSearchParams({
        client_id: STUDIO.id,
        response_type: 'code',
        state: 'native-e2e',
        redirect_uri: STUDIO.redirect,
        code_challenge: first.challenge,
        code_challenge_method: 'S256',
      })}`,
      { maxRedirects: 0 }
    );
    expect(authorize.status(), 'silent sign-in for the Studio client').toBe(302);
    const back = new URL(authorize.headers()['location'] ?? '');
    expect(`${back.protocol}//${back.host}${back.pathname}`).toBe(STUDIO.redirect);
    const signedIn = await token(page.request, back.searchParams.get('code') ?? '', first.verifier);
    expect(signedIn.status()).toBe(200);
    const { access_token } = (await signedIn.json()) as { access_token: string };
    const bearer = { authorization: `Bearer ${access_token}` };

    // Add a passkey from the app
    const authenticator = await new SoftAuthenticator().init();
    const regOptions = await page.request.post(`${AUTH}/native/passkey/register/options`, { headers: bearer, data: {} });
    expect(regOptions.status(), await regOptions.text()).toBe(200);
    const reg = (await regOptions.json()) as { challenge_id: string; publicKey: { rp: { id: string } } };
    const rpId = reg.publicKey.rp.id;
    expect(new URL(AUTH).hostname).toBe(rpId === 'localhost' ? 'localhost' : `auth.${rpId}`);
    const added = await page.request.post(`${AUTH}/native/passkey/register/verify`, {
      headers: bearer,
      data: { challenge_id: reg.challenge_id, credential: await authenticator.create(reg.publicKey, nativeOrigin(rpId)), name: 'E2E Studio' },
    });
    expect(added.status(), await added.text()).toBe(200);
    expect(await added.json()).toMatchObject({ id: authenticator.credentialId, name: 'E2E Studio' });

    // Sign in with it: no cookies, as the app would (a fresh request context)
    const app = await playwright.request.newContext();
    const second = await pkce();
    const options = await app.post(`${AUTH}/native/passkey/options`, {
      data: { client_id: STUDIO.id, code_challenge: second.challenge, code_challenge_method: 'S256' },
    });
    expect(options.status(), await options.text()).toBe(200);
    const { challenge_id, publicKey } = (await options.json()) as { challenge_id: string; publicKey: { rpId: string } };
    expect(publicKey.rpId).toBe(rpId);
    const credential = await authenticator.get(publicKey, nativeOrigin(rpId));
    const verified = await app.post(`${AUTH}/native/passkey/verify`, { data: { challenge_id, client_id: STUDIO.id, credential } });
    expect(verified.status(), await verified.text()).toBe(200);
    const { code } = (await verified.json()) as { code: string };

    // The challenge is single use
    const replay = await app.post(`${AUTH}/native/passkey/verify`, { data: { challenge_id, client_id: STUDIO.id, credential } });
    expect(replay.status()).toBe(401);
    expect(await replay.json()).toMatchObject({ error: 'invalid_credential' });

    // The code is exchanged at the usual /token with this sign-in's PKCE verifier: same tokens as the browser flow
    const tokens = await token(app, code, second.verifier);
    expect(tokens.status(), await tokens.text()).toBe(200);
    const issued = (await tokens.json()) as { access_token: string; refresh_token?: string };
    expect(claims(issued.access_token).amr).toContain('passkey');
    expect(claims(issued.access_token).aud).toBe(STUDIO.id);
    await app.dispose();
  });
});
