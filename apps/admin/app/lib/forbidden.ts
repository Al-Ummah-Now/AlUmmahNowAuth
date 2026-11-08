/**
 * Access-denied page for a signed-in user without an admin role (#219).
 *
 * It used to send the browser back to the account picker after 3 seconds;
 * picking the same account landed here again, in a loop. The page now stays
 * put and offers explicit actions: sign out everywhere, use another account,
 * or go to the user's apps (profile).
 */

export type ForbiddenLocale = "en" | "ar";

export const FORBIDDEN_COPY = {
  en: {
    title: "Access denied",
    signedInAs: "Signed in as",
    body: "This account does not have administrator access to the Al Ummah Now auth admin.",
    hint: "Sign in with an administrator account, or ask a Super Admin for access.",
    switchAccount: "Use another account",
    signOut: "Sign out",
    yourApps: "Go to your apps",
    otherLanguage: "العربية",
  },
  ar: {
    title: "تم رفض الوصول",
    signedInAs: "تم تسجيل الدخول باسم",
    body: "لا يملك هذا الحساب صلاحية المسؤول للوصول إلى لوحة إدارة المصادقة في الأمة الآن.",
    hint: "سجّل الدخول بحساب مسؤول، أو اطلب الصلاحية من مسؤول أعلى.",
    switchAccount: "استخدام حساب آخر",
    signOut: "تسجيل الخروج",
    yourApps: "الانتقال إلى تطبيقاتك",
    otherLanguage: "English",
  },
} as const satisfies Record<ForbiddenLocale, Record<string, string>>;

/** ?lang= wins, then the browser's Accept-Language; English otherwise. */
export function forbiddenLocale(request: Request): ForbiddenLocale {
  const lang = new URL(request.url).searchParams.get("lang");
  if (lang === "ar" || lang === "en") return lang;
  const accept = request.headers.get("Accept-Language") ?? "";
  return /^\s*ar\b/i.test(accept) ? "ar" : "en";
}

/** The profile app (the user's apps) next to this auth server: profile.<auth host>. */
export function profileAppUrl(authServerUrl: string): string {
  const auth = new URL(authServerUrl);
  if (auth.hostname === "localhost" || auth.hostname === "127.0.0.1") return "http://localhost:3302/";
  return `${auth.protocol}//profile.${auth.host}/`;
}
