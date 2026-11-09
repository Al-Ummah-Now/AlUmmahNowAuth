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
}): string {
  const url = new URL("/authorize", o.authServerUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", o.clientId);
  url.searchParams.set("redirect_uri", o.redirectUri);
  url.searchParams.set("state", o.state);
  if (o.prompt) url.searchParams.set("prompt", o.prompt);
  return url.toString();
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

