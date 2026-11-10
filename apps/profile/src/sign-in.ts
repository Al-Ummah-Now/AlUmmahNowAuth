/**
 * Sign-in plumbing for the profile app ("if you are signed in, you are signed in").
 *
 * There is no landing page: a visit without a profile session goes to /login,
 * which sends the browser to the auth server's /authorize with NO prompt, so a
 * browser already signed in to Al Ummah Now gets a code silently for auth's
 * active account and everyone else gets the sign-in form. The path the user
 * was going to travels in a short-lived cookie bound to the OAuth `state`.
 */

export type LoginPrompt = "none" | "login";

/** Cookie holding `<state>.<return path>` between /login and /callback. */
export const LOGIN_COOKIE = "profile_login";
const LOGIN_COOKIE_MAX_AGE = 10 * 60;

/** A same-origin path to return to after sign-in; anything else becomes "/". */
export function safeReturnPath(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  // Control characters (and a backslash anywhere) have no place in our paths
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c < 0x20 || c === 0x7f || c === 0x5c) return "/";
  }
  // Never bounce back into the sign-in plumbing itself
  const path = raw.split(/[?#]/)[0];
  if (path === "/login" || path === "/callback" || path === "/logout") return "/";
  return raw;
}

/** Only the two prompts apps may ask for: silent (none) and add-account (login). */
export function parsePrompt(raw: string | null | undefined): LoginPrompt | undefined {
  return raw === "none" || raw === "login" ? raw : undefined;
}

/** The app's /login URL for `returnTo` (and an optional prompt). */
export function loginPath(returnTo: string, prompt?: LoginPrompt): string {
  const params = new URLSearchParams({ return: safeReturnPath(returnTo) });
  if (prompt) params.set("prompt", prompt);
  return `/login?${params}`;
}

export function buildAuthorizeUrl(o: {
  authServerUrl: string;
  clientId: string;
  redirectUri: string;
  state: string;
  prompt?: LoginPrompt;
  /** Only an explicit Arabic request is passed on; the sign-in pages default to English. */
  lang?: "ar";
  /** PKCE (S256) challenge; its verifier is kept in the PKCE cookie */
  codeChallenge?: string;
}): string {
  const url = new URL("/authorize", o.authServerUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", o.clientId);
  url.searchParams.set("redirect_uri", o.redirectUri);
  url.searchParams.set("state", o.state);
  if (o.prompt) url.searchParams.set("prompt", o.prompt);
  if (o.lang === "ar") url.searchParams.set("lang", "ar");
  if (o.codeChallenge) {
    url.searchParams.set("code_challenge", o.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  return url.toString();
}

/**
 * PKCE (RFC 7636): /login keeps the verifier in this cookie, bound to the
 * OAuth state; /callback sends it with the code. A code that leaks (logs,
 * Referer, a proxy) can't be redeemed without it, and the auth server can
 * require PKCE for this client.
 */
export const PKCE_COOKIE = "profile_pkce";

export function pkceCookie(state: string, verifier: string, isLocalhost: boolean): string {
  const secure = isLocalhost ? "" : "Secure; ";
  return `${PKCE_COOKIE}=${state}.${verifier}; Path=/; HttpOnly; ${secure}SameSite=Lax; Max-Age=${LOGIN_COOKIE_MAX_AGE}`;
}

export function clearPkceCookie(isLocalhost: boolean): string {
  const secure = isLocalhost ? "" : "Secure; ";
  return `${PKCE_COOKIE}=; Path=/; HttpOnly; ${secure}SameSite=Lax; Max-Age=0`;
}

/** The verifier /login stored for this `state`, if any. */
export function savedPkceVerifier(cookieHeader: string | null, state: string | null): string | undefined {
  const raw = readCookie(cookieHeader, PKCE_COOKIE);
  if (!raw || !state) return undefined;
  const dot = raw.indexOf(".");
  if (dot <= 0 || raw.slice(0, dot) !== state) return undefined;
  return raw.slice(dot + 1) || undefined;
}

export function loginCookie(state: string, returnTo: string, isLocalhost: boolean): string {
  const secure = isLocalhost ? "" : "Secure; ";
  const value = `${state}.${encodeURIComponent(safeReturnPath(returnTo))}`;
  return `${LOGIN_COOKIE}=${value}; Path=/; HttpOnly; ${secure}SameSite=Lax; Max-Age=${LOGIN_COOKIE_MAX_AGE}`;
}

export function clearLoginCookie(isLocalhost: boolean): string {
  const secure = isLocalhost ? "" : "Secure; ";
  return `${LOGIN_COOKIE}=; Path=/; HttpOnly; ${secure}SameSite=Lax; Max-Age=0`;
}

export function readCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/**
 * Where /callback sends the browser: the path saved by /login when its state
 * matches the callback's, otherwise "/".
 */
export function savedReturnPath(cookieHeader: string | null, state: string | null): string {
  const raw = readCookie(cookieHeader, LOGIN_COOKIE);
  if (!raw || !state) return "/";
  const dot = raw.indexOf(".");
  if (dot < 0 || raw.slice(0, dot) !== state) return "/";
  try {
    return safeReturnPath(decodeURIComponent(raw.slice(dot + 1)));
  } catch {
    return "/";
  }
}


/**
 * Whether the callback's `state` is the one this browser's /login issued
 * (the login cookie exists and holds exactly that state). Callbacks that fail
 * this are rejected before any code exchange or session change, so a forged
 * callback link cannot sign the browser in as someone else (login CSRF) or
 * end its current session.
 */
export function stateMatches(cookieHeader: string | null, state: string | null): boolean {
  const raw = readCookie(cookieHeader, LOGIN_COOKIE);
  if (!raw || !state) return false;
  const dot = raw.indexOf(".");
  if (dot <= 0) return false;
  const expected = raw.slice(0, dot);
  if (expected.length !== state.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ state.charCodeAt(i);
  return diff === 0;
}
