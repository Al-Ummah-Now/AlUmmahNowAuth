import type { Locale } from "./apps";

export const LOCALES: readonly Locale[] = ["en", "ar"];
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
  signOut: "Sign out",
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
  signedInAccounts: "Your accounts",
  moreAccounts: "More accounts",
  switchTo: "Switch to {name}",
  addAccount: "Add another account",
  manageSessions: "Manage sessions",
  signOutAll: "Sign out of all accounts",
  active: "Current account",
  lastUsed: "Last used",
  justNow: "just now",
  minutesAgo: "{n}m ago",
  hoursAgo: "{n}h ago",
  daysAgo: "{n}d ago",
  signOutAccount: "Sign out",
  confirmCancel: "Cancel",
  signOutAllTitle: "Sign out of all accounts?",
  signOutAllMessage: "Every account is signed out of this browser. You will need to sign in again.",
  signOutAllAction: "Sign out of all",
  signOutAccountTitle: "Sign out of this account?",
  signOutAccountMessage: "{email} is signed out of this browser.",
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
  signedInAccounts: "حساباتك",
  moreAccounts: "حسابات أخرى",
  switchTo: "التبديل إلى {name}",
  addAccount: "إضافة حساب آخر",
  manageSessions: "إدارة الجلسات",
  signOutAll: "تسجيل الخروج من كل الحسابات",
  active: "الحساب الحالي",
  lastUsed: "آخر استخدام",
  justNow: "الآن",
  minutesAgo: "منذ {n} د",
  hoursAgo: "منذ {n} س",
  daysAgo: "منذ {n} ي",
  signOutAccount: "تسجيل الخروج",
  confirmCancel: "إلغاء",
  signOutAllTitle: "تسجيل الخروج من كل الحسابات؟",
  signOutAllMessage: "سيتم تسجيل الخروج من كل الحسابات في هذا المتصفح، وستحتاج إلى تسجيل الدخول مجددًا.",
  signOutAllAction: "تسجيل الخروج من الكل",
  signOutAccountTitle: "تسجيل الخروج من هذا الحساب؟",
  signOutAccountMessage: "سيتم تسجيل خروج {email} من هذا المتصفح.",
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

/**
 * English unless the link asks for another language with `?lang=` (only "ar"
 * today). Neither a saved cookie nor the browser's Accept-Language is used, so
 * the profile matches the sign-in pages; an unsupported value is English.
 */
export function pickLocale(request: Request): Locale {
  return localeOf(new URL(request.url).searchParams.get("lang"));
}

/** A supported locale for a `lang` value, English otherwise. */
export function localeOf(lang: string | null | undefined): Locale {
  return isLocale(lang) ? lang : "en";
}
