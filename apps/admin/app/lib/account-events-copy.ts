/**
 * Words for Admin > Account events (AlUmmahNowAuth#507), in English and in Arabic for ?lang=ar
 * (lib/deletion-copy.ts langOf).
 */
import type { AdminLang } from "./deletion-copy";
import { AR_ATTEMPTS, countOf } from "./admin-copy";
import { formatNumber } from "../../../../packages/ui/src/format.ts";

export type EventStatus = "failed" | "pending" | "delivered";

export interface AccountEventsCopy {
  pageTitle: string;
  pageIntro: string;
  appsTitle: string;
  appsIntro: string;
  noApps: string;
  colApp: string;
  colReceives: string;
  colLast: string;
  colWaiting: string;
  colFailed: string;
  never: string;
  /** A count; past the limit nobody counted on. */
  count(n: number, limit: number): string;
  deliveriesTitle: string;
  deliveriesIntro: string;
  filterLabel: string;
  status: Record<EventStatus, string>;
  empty: Record<EventStatus, string>;
  onlyApp(name: string): string;
  allApps: string;
  colEvent: string;
  colUser: string;
  colHappened: string;
  colResult: string;
  colAction: string;
  attempts(n: number): string;
  deliveredAt: string;
  failedAt: string;
  event: Record<string, string>;
  reason: Record<string, string>;
  noUser: string;
  error: Record<"timeout" | "network error" | "not subscribed" | "could not be sent after every retry", string>;
  answered: string;
  notSentYet: string;
  sendAgain: string;
  sending: string;
  confirmTitle: string;
  confirmBody(event: string, app: string): string;
  confirm: string;
  cancel: string;
  queued: string;
  errors: Record<"not_failed" | "rate_limited" | "generic", string>;
  newest: string;
  older: string;
  pages: string;
  loadWhat: string;
  listSep: string;
}

const en: AccountEventsCopy = {
  pageTitle: "Account events",
  pageIntro: "What other apps are told when an account is disabled, enabled or erased, so that they hide, show or erase its data too. An event never holds an email, a name or an age.",
  appsTitle: "Apps",
  appsIntro: "The apps that receive events, and where each is sent.",
  noApps: "No app receives account events yet.",
  colApp: "App",
  colReceives: "Receives",
  colLast: "Last delivered",
  colWaiting: "Waiting",
  colFailed: "Failed",
  never: "Never",
  count: (n, limit) => (n >= limit ? `${formatNumber(limit, "en")}+` : formatNumber(n, "en")),
  deliveriesTitle: "Deliveries",
  deliveriesIntro: "A delivery is tried for about half an hour before it fails. Delivered events are kept for 30 days, failed ones until they are delivered.",
  filterLabel: "Deliveries to show",
  status: { failed: "Failed", pending: "Waiting", delivered: "Delivered" },
  empty: { failed: "Nothing failed.", pending: "Nothing is waiting.", delivered: "Nothing was delivered in the last 30 days." },
  onlyApp: (name) => `Only ${name}`,
  allApps: "Show all apps",
  colEvent: "Event",
  colUser: "Account",
  colHappened: "Happened",
  colResult: "Result",
  colAction: "Action",
  attempts: (n) => countOf(n, "en", ["try", "tries"], AR_ATTEMPTS),
  deliveredAt: "Delivered",
  failedAt: "Failed",
  event: {
    "account-disabled": "Account disabled",
    "account-enabled": "Account enabled",
    "account-purged": "Account erased",
    "account-export-requested": "Data export requested",
    verification: "Connection check",
  },
  reason: { age: "Age rules", deleted: "Deleted, can still be restored" },
  noUser: "No account",
  error: {
    timeout: "No answer within 10 seconds",
    "network error": "Could not connect",
    "not subscribed": "The app no longer receives this event",
    "could not be sent after every retry": "Could not be sent after every retry",
  },
  answered: "The app answered",
  notSentYet: "Not sent yet",
  sendAgain: "Send again",
  sending: "Sending…",
  confirmTitle: "Send this event again?",
  confirmBody: (event, app) => `“${event}” is sent to ${app} again. If the app has already applied a later event of the same account, it ignores this one.`,
  confirm: "Send again",
  cancel: "Cancel",
  queued: "Queued. It shows under Waiting until the app answers.",
  errors: {
    not_failed: "This delivery is no longer failed. Somebody may have sent it again.",
    rate_limited: "Too many requests. Wait a minute and try again.",
    generic: "Something went wrong. Try again.",
  },
  newest: "Newest",
  older: "Older",
  pages: "Pages",
  loadWhat: "the account events",
  listSep: ", ",
};

const ar: AccountEventsCopy = {
  pageTitle: "أحداث الحسابات",
  pageIntro: "ما تُبلَّغ به التطبيقات الأخرى عند تعطيل حساب أو تفعيله أو محوه، لتُخفي بياناته أو تُظهرها أو تمحوها هي أيضًا. لا يحمل أي حدث بريدًا إلكترونيًا ولا اسمًا ولا عمرًا.",
  appsTitle: "التطبيقات",
  appsIntro: "التطبيقات التي تتلقى الأحداث، وعنوان إرسال كل منها.",
  noApps: "لا يتلقى أي تطبيق أحداث الحسابات بعد.",
  colApp: "التطبيق",
  colReceives: "يتلقى",
  colLast: "آخر تسليم",
  colWaiting: "بالانتظار",
  colFailed: "فشلت",
  never: "لم يُسلَّم شيء",
  count: (n, limit) => (n >= limit ? `${formatNumber(limit, "ar")} أو أكثر` : formatNumber(n, "ar")),
  deliveriesTitle: "التسليمات",
  deliveriesIntro: `تُعاد محاولة التسليم نحو نصف ساعة قبل أن يُعدّ فاشلًا. تُحفَظ الأحداث المسلَّمة ${formatNumber(30, "ar")} يومًا، والفاشلة حتى تُسلَّم.`,
  filterLabel: "التسليمات المعروضة",
  status: { failed: "فشلت", pending: "بالانتظار", delivered: "سُلِّمت" },
  empty: { failed: "لا يوجد تسليم فاشل.", pending: "لا يوجد تسليم بالانتظار.", delivered: `لم يُسلَّم شيء في آخر ${formatNumber(30, "ar")} يومًا.` },
  onlyApp: (name) => `${name} فقط`,
  allApps: "عرض كل التطبيقات",
  colEvent: "الحدث",
  colUser: "الحساب",
  colHappened: "وقت الحدث",
  colResult: "النتيجة",
  colAction: "الإجراء",
  attempts: (n) => countOf(n, "ar", ["try", "tries"], AR_ATTEMPTS),
  deliveredAt: "سُلِّم",
  failedAt: "فشل",
  event: {
    "account-disabled": "تعطيل حساب",
    "account-enabled": "تفعيل حساب",
    "account-purged": "محو حساب",
    "account-export-requested": "طلب تصدير البيانات",
    verification: "فحص الاتصال",
  },
  reason: { age: "قواعد العمر", deleted: "محذوف، ويمكن استعادته" },
  noUser: "لا حساب",
  error: {
    timeout: `لا رد خلال ${formatNumber(10, "ar")} ثوانٍ`,
    "network error": "تعذّر الاتصال",
    "not subscribed": "لم يعد التطبيق يتلقى هذا الحدث",
    "could not be sent after every retry": "تعذّر الإرسال بعد كل المحاولات",
  },
  answered: "ردّ التطبيق",
  notSentYet: "لم يُرسَل بعد",
  sendAgain: "إعادة الإرسال",
  sending: "جارٍ الإرسال…",
  confirmTitle: "إعادة إرسال هذا الحدث؟",
  confirmBody: (event, app) => `يُرسَل حدث «${event}» إلى ${app} مرة أخرى. وإن كان التطبيق قد طبّق حدثًا أحدث للحساب نفسه فسيتجاهل هذا الحدث.`,
  confirm: "إعادة الإرسال",
  cancel: "إلغاء",
  queued: "أُضيف إلى قائمة الإرسال. يظهر ضمن «بالانتظار» حتى يردّ التطبيق.",
  errors: {
    not_failed: "لم يعد هذا التسليم فاشلًا. ربما أعاد شخص آخر إرساله.",
    rate_limited: "طلبات كثيرة. انتظر دقيقة ثم حاول مرة أخرى.",
    generic: "حدث خطأ. حاول مرة أخرى.",
  },
  newest: "الأحدث",
  older: "الأقدم",
  pages: "الصفحات",
  loadWhat: "أحداث الحسابات",
  listSep: "، ",
};

export const accountEventsCopy = (lang: AdminLang): AccountEventsCopy => (lang === "ar" ? ar : en);

/** Why a delivery failed (apps/auth account-events/deliver.ts): words, or the app's answer ("503", "400 invalid_key"). */
export function errorOf(t: AccountEventsCopy, error: string | null): { text: string; code?: string } | null {
  if (!error) return null;
  if (/^\d{3}( [a-z_]+)?$/.test(error)) return { text: t.answered, code: error };
  return { text: Object.hasOwn(t.error, error) ? t.error[error as keyof AccountEventsCopy["error"]] : t.errors.generic };
}
