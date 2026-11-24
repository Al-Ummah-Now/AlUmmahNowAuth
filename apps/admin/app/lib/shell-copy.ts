/**
 * The admin shell's own words (header, side rail), in English and in Arabic for ?lang=ar, the
 * admin's existing language switch for its dialogs (lib/deletion-copy.ts langOf). Arabic terms
 * follow the ones already in use: «إدارة الحسابات» (app-links), «عملاء OAuth» and
 * «سمات تسجيل الدخول» (deletion-copy).
 */
import type { AdminLang } from "./deletion-copy";
import { sameSitePath } from "../../../../packages/ui/src/nav/page-header.ts";

export type NavKey = "dashboard" | "users" | "roles" | "sessions" | "clients" | "audit" | "moderation" | "themes" | "deleted" | "security" | "signingKeys" | "accountEvents";

export interface ShellCopy {
  brand: string;
  app: string;
  expand: string;
  collapse: string;
  openMenu: string;
  closeMenu: string;
  navLabel: string;
  nav: Record<NavKey, string>;
}

const en: ShellCopy = {
  brand: "Al Ummah Now",
  app: "Accounts admin",
  expand: "Expand sidebar",
  collapse: "Collapse sidebar",
  openMenu: "Open menu",
  closeMenu: "Close menu",
  navLabel: "Admin sections",
  nav: {
    dashboard: "Dashboard",
    users: "Users",
    roles: "Roles",
    sessions: "Sessions",
    clients: "OAuth Clients",
    audit: "Audit Logs",
    moderation: "Moderation",
    themes: "Sign-in themes",
    deleted: "Recently deleted",
    security: "Security",
    signingKeys: "Signing keys",
    accountEvents: "Account events",
  },
};

const ar: ShellCopy = {
  brand: "الأمة الآن",
  app: "إدارة الحسابات",
  expand: "توسيع الشريط الجانبي",
  collapse: "طي الشريط الجانبي",
  openMenu: "فتح القائمة",
  closeMenu: "إغلاق القائمة",
  navLabel: "أقسام الإدارة",
  nav: {
    dashboard: "لوحة المعلومات",
    users: "المستخدمون",
    roles: "الأدوار",
    sessions: "الجلسات",
    clients: "عملاء OAuth",
    audit: "سجل التدقيق",
    moderation: "الإشراف",
    themes: "سمات تسجيل الدخول",
    deleted: "المحذوفة مؤخرًا",
    security: "الأمان",
    signingKeys: "مفاتيح التوقيع",
    accountEvents: "أحداث الحسابات",
  },
};

export const shellCopy = (lang: AdminLang): ShellCopy => (lang === "ar" ? ar : en);

/** A rail link that keeps the page language (?lang=ar) across sections. */
export function withLang(href: string, lang: AdminLang): string {
  return lang === "ar" ? `${href}${href.includes("?") ? "&" : "?"}lang=ar` : href;
}

/**
 * The language button's link: this page and query with ?lang= swapped (English drops it, as the
 * rail's withLang links do).
 */
export function langSwitchHref(pathname: string, search: string, lang: AdminLang): string {
  const params = new URLSearchParams(search);
  if (lang === "ar") params.delete("lang");
  else params.set("lang", "ar");
  const q = params.toString();
  // never protocol-relative (a path like //evil.example): see sameSitePath
  return `${sameSitePath(pathname)}${q ? `?${q}` : ""}`;
}
