/**
 * Single sign-out: after clearing the admin session, continue the auth
 * server's chain (?next=<auth>/logout?...) or start it.
 */
export function singleSignOutNext(url: URL, authServerUrl: string): string {
  const auth = new URL(authServerUrl);
  const next = url.searchParams.get("next");
  if (next) {
    try {
      const target = new URL(next);
      if (target.origin === auth.origin && target.pathname === "/logout") return target.toString();
    } catch {
      // ignore a malformed next
    }
  }
  const start = new URL("/logout", auth.origin);
  start.searchParams.set("return", `${url.origin}/`);
  return start.toString();
}
