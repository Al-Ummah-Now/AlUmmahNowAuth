import type { LoaderFunctionArgs } from "react-router";
import { redirect, useLoaderData } from "react-router";
import { getAppUrl } from "../lib/config";
import { getOpenAuthClient } from "../lib/openauth.client.server";
import { logger } from "../lib/logger.server";
import { loginCookie, loginPath, parseMaxAge, parsePrompt, safeReturnPath, withPrompt, pkceCookie } from "../lib/sign-in";

/**
 * Straight to the auth server, no page of our own. No prompt by default: a
 * browser already signed in to Al Ummah Now comes back with a code silently
 * for auth's active account, everyone else gets the sign-in form.
 * `prompt=none` (silent re-auth after switching or a lapsed refresh) and
 * `prompt=login` (add an account) on request. `redirect` is where to land.
 *
 * A failed sign-in comes back here with ?error= and is shown with a retry
 * link instead of redirecting again, so a persistent error cannot loop.
 */
export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context?.cloudflare?.env as { APP_URL?: string; AUTH_SERVER_URL?: string; ADMIN_CLIENT_ID?: string };
  const ctx = context?.cloudflare?.ctx as ExecutionContext;

  // Initialize logger
  logger.setDatabase(null, false);
  if (ctx) logger.setContext(ctx);

  logger.logLoader('login', request);

  const url = new URL(request.url);
  const returnTo = safeReturnPath(url.searchParams.get("redirect") ?? url.searchParams.get("return"));
  const error = url.searchParams.get("error");
  if (error) {
    // Friendly text for known codes; the raw code stays out of the page
    const message =
      error === "invalid_state" ? "This sign-in link has expired or was already used." : error;
    return { error: message, retryUrl: loginPath(returnTo) };
  }

  const appUrl = getAppUrl(request, env);
  const client = getOpenAuthClient(request, env);
  const { url: baseAuthorizeUrl, challenge } = await client.authorize(`${appUrl}/auth/callback`, "code", { pkce: true });
  // Step-up (AUTH-PASSKEYS): prompt=login&max_age=900 asks for a fresh sign-in
  const authorizeUrl = withPrompt(baseAuthorizeUrl, parsePrompt(url.searchParams.get("prompt")), parseMaxAge(url.searchParams.get("max_age")));
  logger.info('Redirecting to auth server', { authorizeUrl });

  const headers = new Headers({ "Cache-Control": "no-store" });
  headers.append("Set-Cookie", loginCookie(challenge.state, returnTo));
  if (challenge.verifier) headers.append("Set-Cookie", pkceCookie(challenge.state, challenge.verifier));
  return redirect(authorizeUrl, { headers });
}

export default function Login() {
  const data = useLoaderData<typeof loader>();
  // Only rendered for a failed sign-in (the loader redirects otherwise)
  return (
    <div className="min-h-screen bg-[rgb(var(--color-background))] flex items-center justify-center p-6">
      <div className="text-center max-w-md" data-testid="login-error">
        <h1 className="text-xl font-semibold text-[rgb(var(--color-foreground))] mb-3">Sign-in did not complete</h1>
        <p className="text-sm text-[rgb(var(--color-muted-foreground))] mb-6 break-words">{data?.error}</p>
        <a
          href={data?.retryUrl ?? "/login"}
          className="inline-block rounded-lg px-4 py-2.5 text-sm font-semibold bg-[rgb(var(--color-primary))] text-[rgb(var(--color-primary-foreground))]"
        >
          Try again
        </a>
      </div>
    </div>
  );
}
