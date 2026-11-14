/**
 * The admin shell's own words (header, side rail), in English and in Arabic for ?lang=ar, the
 * admin's existing language switch for its dialogs (lib/deletion-copy.ts langOf). Arabic terms
 * follow the ones already in use: «إدارة الحسابات» (app-links), «عملاء OAuth» and
 * «سمات تسجيل الدخول» (deletion-copy).
 */
import type { AdminLang } from "./deletion-copy";

export type NavKey = "dashboard" | "users" | "roles" | "sessions" | "clients" | "audit" | "moderation" | "themes" | "deleted" | "security";

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
  },
};

export const shellCopy = (lang: AdminLang): ShellCopy => (lang === "ar" ? ar : en);

/** A rail link that keeps the page language (?lang=ar) across sections. */
export function withLang(href: string, lang: AdminLang): string {
  return lang === "ar" ? `${href}${href.includes("?") ? "&" : "?"}lang=ar` : href;
}
