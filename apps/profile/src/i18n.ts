import type { Locale } from "./apps";

export const LOCALES: readonly Locale[] = ["en", "ar"];
export const LANG_COOKIE = "profile_lang";

const en = {
  pageTitle: "Al Ummah Now - User Profile",
  brand: "Al Ummah Now",
  brandApp: "Profile",
  appsButton: "Al Ummah Now apps",
  appsHeading: "Your apps",
  appsSubheading: "Jump to another Al Ummah Now app. You stay signed in.",
  groupApps: "Apps",
  groupAdmin: "Administration",
  current: "You're here",
  open: "Open",
  switchLanguage: "العربية",
  switchLanguageLabel: "التبديل إلى العربية",
  signIn: "Sign In",
  signOut: "Sign Out",
  heroTitle: "Welcome to Your Profile",
  heroBody: "Sign in to view and manage your Al Ummah Now profile, preferences, and account settings.",
  welcomeTitle: "Welcome back!",
  welcomeBody: "You are successfully logged in to your Al Ummah Now profile.",
  profileHeading: "Your Profile",
  userId: "User ID",
  email: "Email Address",
  role: "Role",
  noRoles: "No roles assigned",
  loading: "Loading...",
  accountMenu: "Account menu",
  signedInAccounts: "Signed in accounts",
  addAccount: "Add another account",
  manageSessions: "Manage sessions",
  signOutAll: "Sign out of all accounts",
  active: "Active",
  lastUsed: "Last used",
  justNow: "just now",
  minutesAgo: "{n}m ago",
  hoursAgo: "{n}h ago",
  daysAgo: "{n}d ago",
  signOutAccount: "Sign out",
  authError: "Authentication Error:",
  footer: "© 2025 Al Ummah Now.",
};

export type Messages = typeof en;

const ar: Messages = {
  pageTitle: "الأمة الآن - الملف الشخصي",
  brand: "الأمة الآن",
  brandApp: "الملف الشخصي",
  appsButton: "تطبيقات الأمة الآن",
  appsHeading: "تطبيقاتك",
  appsSubheading: "انتقل إلى تطبيق آخر من تطبيقات الأمة الآن دون الحاجة لتسجيل الدخول من جديد.",
  groupApps: "التطبيقات",
  groupAdmin: "الإدارة",
  current: "أنت هنا",
  open: "فتح",
  switchLanguage: "English",
  switchLanguageLabel: "Switch to English",
  signIn: "تسجيل الدخول",
  signOut: "تسجيل الخروج",
  heroTitle: "مرحبًا بك في ملفك الشخصي",
  heroBody: "سجّل الدخول لعرض ملفك الشخصي في الأمة الآن وإدارة تفضيلاتك وإعدادات حسابك.",
  welcomeTitle: "مرحبًا بعودتك!",
  welcomeBody: "تم تسجيل دخولك بنجاح إلى ملفك الشخصي في الأمة الآن.",
  profileHeading: "ملفك الشخصي",
  userId: "معرّف المستخدم",
  email: "البريد الإلكتروني",
  role: "الدور",
  noRoles: "لا توجد أدوار",
  loading: "جارٍ التحميل...",
  accountMenu: "قائمة الحساب",
  signedInAccounts: "الحسابات المسجّلة",
  addAccount: "إضافة حساب آخر",
  manageSessions: "إدارة الجلسات",
  signOutAll: "تسجيل الخروج من كل الحسابات",
  active: "نشط",
  lastUsed: "آخر استخدام",
  justNow: "الآن",
  minutesAgo: "منذ {n} د",
  hoursAgo: "منذ {n} س",
  daysAgo: "منذ {n} ي",
  signOutAccount: "تسجيل الخروج",
  authError: "خطأ في المصادقة:",
  footer: "© 2025 الأمة الآن.",
};

export const MESSAGES: Record<Locale, Messages> = { en, ar };

export function isLocale(value: string | null | undefined): value is Locale {
  return value === "en" || value === "ar";
}

export function dirFor(locale: Locale): "ltr" | "rtl" {
  return locale === "ar" ? "rtl" : "ltr";
}

function readCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(/;\s*/)) {
    const [key, ...rest] = part.split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

/**
 * Locale precedence: ?lang= (explicit switch) > saved cookie > Accept-Language > en.
 * Returns whether the choice came from the query so the caller can persist it.
 */
export function pickLocale(request: Request): { locale: Locale; fromQuery: boolean } {
  const query = new URL(request.url).searchParams.get("lang");
  if (isLocale(query)) return { locale: query, fromQuery: true };

  const cookie = readCookie(request.headers.get("Cookie"), LANG_COOKIE);
  if (isLocale(cookie)) return { locale: cookie, fromQuery: false };

  const accept = request.headers.get("Accept-Language") ?? "";
  const ranked = accept
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.find((p) => p.trim().startsWith("q="));
      return { lang: tag.toLowerCase().split("-")[0], q: q ? Number(q.trim().slice(2)) : 1 };
    })
    .filter((x) => x.lang && !Number.isNaN(x.q) && x.q > 0)
    .sort((a, b) => b.q - a.q);
  const match = ranked.find((x) => isLocale(x.lang));
  return { locale: match ? (match.lang as Locale) : "en", fromQuery: false };
}

export function langCookie(locale: Locale, isLocalhost: boolean): string {
  const secure = isLocalhost ? "" : "Secure; ";
  return `${LANG_COOKIE}=${locale}; Path=/; ${secure}SameSite=Lax; Max-Age=${365 * 24 * 60 * 60}`;
}
