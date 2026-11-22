/**
 * The account menu's "Al Ummah Now apps" (AlUmmahNow docs/design/NAV.md): every app but this one,
 * in the shared order and labels. Only admins reach this app, so all staff apps are listed. Hosts
 * come from the auth server's: auth.<domain> → www/videos/cms/admin.<domain>, profile.auth.<domain>.
 */
export function otherApps(authServerUrl: string, lang: "en" | "ar" = "en"): { id: string; label: string; href: string }[] {
  let u: URL;
  try {
    u = new URL(authServerUrl);
  } catch {
    return [];
  }
  if (!u.host.startsWith("auth.")) return [];
  const base = u.host.slice("auth.".length);
  const at = (sub: string) => `${u.protocol}//${sub}.${base}`;
  // Names as Profile's app list has them (apps/profile/src/apps.ts); each link opens in this page's language
  const ar = lang === "ar";
  return [
    { id: "www", label: ar ? "الموقع" : "Website", href: `${at("www")}/${lang}/` },
    { id: "videos", label: ar ? "المرئيات" : "Videos", href: `${at("videos")}/${lang}` },
    { id: "profile", label: ar ? "ملفك الشخصي" : "Your profile", href: `${u.protocol}//profile.${u.host}/?lang=${lang}` },
    { id: "cms", label: ar ? "إدارة المحتوى" : "Content management", href: `${at("cms")}/?lang=${lang}` },
    { id: "admin", label: ar ? "إدارة المرئيات" : "Videos admin", href: ar ? `${at("admin")}/?lang=ar` : at("admin") },
  ];
}
