/**
 * Sign-in plumbing for the auth admin ("if you are signed in, you are signed in").
 *
 * There is no landing page: a request without an admin session goes to
 * /login, which sends the browser to the auth server's /authorize with NO
 * prompt, so a browser already signed in to Al Ummah Now gets a code silently
 * for auth's active account and everyone else gets the sign-in form. The path
 * the user was going to travels in a short-lived cookie bound to the OAuth
 * `state` and /auth/callback returns there.
 */

export type LoginPrompt = "none" | "login";

/** Cookie holding `<state>.<return path>` between /login and /auth/callback. */
export const LOGIN_COOKIE = "admin_login";
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
  if (path === "/login" || path === "/auth/callback" || path === "/logout") return "/";
  return raw;
}

/** Only the two prompts the app asks for: silent (none) and add-account (login). */
export function parsePrompt(raw: string | null | undefined): LoginPrompt | undefined {
  return raw === "none" || raw === "login" ? raw : undefined;
}

/** The app's /login URL for `returnTo` (and an optional prompt and OIDC max_age in seconds). */
export function loginPath(returnTo: string, prompt?: LoginPrompt, maxAge?: number): string {
  const params = new URLSearchParams({ redirect: safeReturnPath(returnTo) });
  if (prompt) params.set("prompt", prompt);
  if (maxAge !== undefined) params.set("max_age", String(maxAge));
  return `/login?${params}`;
}

/** OIDC max_age from /login's query: whole seconds, else undefined. */
export function parseMaxAge(raw: string | null | undefined): number | undefined {
  if (!raw || !/^\d{1,7}$/.test(raw)) return undefined;
  return Number(raw);
}

/** Adds the prompt (if any) to an authorize URL built by the openauth client. */
export function withPrompt(authorizeUrl: string, prompt?: LoginPrompt, maxAge?: number): string {
  if (!prompt && maxAge === undefined) return authorizeUrl;
  const url = new URL(authorizeUrl);
  if (prompt) url.searchParams.set("prompt", prompt);
  if (maxAge !== undefined) url.searchParams.set("max_age", String(maxAge));
  return url.toString();
}

export function loginCookie(state: string, returnTo: string, secure = true): string {
  const value = `${state}.${encodeURIComponent(safeReturnPath(returnTo))}`;
  return `${LOGIN_COOKIE}=${value}; Path=/; HttpOnly; ${secure ? "Secure; " : ""}SameSite=Lax; Max-Age=${LOGIN_COOKIE_MAX_AGE}`;
}

export function clearLoginCookie(secure = true): string {
  return `${LOGIN_COOKIE}=; Path=/; HttpOnly; ${secure ? "Secure; " : ""}SameSite=Lax; Max-Age=0`;
}

/**
 * PKCE (RFC 7636): /login keeps the code verifier in this cookie, bound to
 * the OAuth state; /auth/callback sends it with the code, so a leaked code
 * can't be redeemed without it and the auth server can require PKCE.
 */
export const PKCE_COOKIE = "admin_pkce";

export function pkceCookie(state: string, verifier: string, secure = true): string {
  return `${PKCE_COOKIE}=${state}.${verifier}; Path=/; HttpOnly; ${secure ? "Secure; " : ""}SameSite=Lax; Max-Age=${LOGIN_COOKIE_MAX_AGE}`;
}

export function clearPkceCookie(secure = true): string {
  return `${PKCE_COOKIE}=; Path=/; HttpOnly; ${secure ? "Secure; " : ""}SameSite=Lax; Max-Age=0`;
}

/** The verifier /login stored for this `state`, if any. */
export function savedPkceVerifier(cookieHeader: string | null, state: string | null): string | undefined {
  const raw = readCookie(cookieHeader, PKCE_COOKIE);
  if (!raw || !state) return undefined;
  const dot = raw.indexOf(".");
  if (dot <= 0 || raw.slice(0, dot) !== state) return undefined;
  return raw.slice(dot + 1) || undefined;
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
 * Where /auth/callback sends the browser: the path saved by /login when its
 * state matches the callback's, otherwise "/".
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
