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

/** The app's /login URL for `returnTo` (and an optional prompt). */
export function loginPath(returnTo: string, prompt?: LoginPrompt): string {
  const params = new URLSearchParams({ redirect: safeReturnPath(returnTo) });
  if (prompt) params.set("prompt", prompt);
  return `/login?${params}`;
}

/** Adds the prompt (if any) to an authorize URL built by the openauth client. */
export function withPrompt(authorizeUrl: string, prompt?: LoginPrompt): string {
  if (!prompt) return authorizeUrl;
  const url = new URL(authorizeUrl);
  url.searchParams.set("prompt", prompt);
  return url.toString();
}

export function loginCookie(state: string, returnTo: string, secure = true): string {
  const value = `${state}.${encodeURIComponent(safeReturnPath(returnTo))}`;
  return `${LOGIN_COOKIE}=${value}; Path=/; HttpOnly; ${secure ? "Secure; " : ""}SameSite=Lax; Max-Age=${LOGIN_COOKIE_MAX_AGE}`;
}

export function clearLoginCookie(secure = true): string {
  return `${LOGIN_COOKIE}=; Path=/; HttpOnly; ${secure ? "Secure; " : ""}SameSite=Lax; Max-Age=0`;
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
