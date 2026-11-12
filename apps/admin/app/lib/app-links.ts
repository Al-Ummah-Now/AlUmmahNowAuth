/**
 * The account menu's "Al Ummah Now apps" (AlUmmahNow docs/design/NAV.md): every app but this one,
 * in the shared order and labels. Only admins reach this app, so all staff apps are listed. Hosts
 * come from the auth server's: auth.<domain> → www/videos/cms/admin.<domain>, profile.auth.<domain>.
 */
export function otherApps(authServerUrl: string): { id: string; label: string; href: string }[] {
  let u: URL;
  try {
    u = new URL(authServerUrl);
  } catch {
    return [];
  }
  if (!u.host.startsWith("auth.")) return [];
  const base = u.host.slice("auth.".length);
  const at = (sub: string) => `${u.protocol}//${sub}.${base}`;
  return [
    { id: "www", label: "Website", href: `${at("www")}/en/` },
    { id: "videos", label: "Videos", href: `${at("videos")}/en` },
    { id: "profile", label: "Your profile", href: `${u.protocol}//profile.${u.host}/?lang=en` },
    { id: "cms", label: "Content management", href: `${at("cms")}/?lang=en` },
    { id: "admin", label: "Videos admin", href: at("admin") },
  ];
}
