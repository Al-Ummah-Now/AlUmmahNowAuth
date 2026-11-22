/**
 * Words for Admin > Signing keys (signing-key rotation, AlUmmahNowAuth#13), in
 * English and in Arabic for ?lang=ar (lib/deletion-copy.ts langOf).
 */
import type { AdminLang } from "./deletion-copy";
import { formatNumber } from "../../../../packages/ui/src/format.ts";

export type SigningKeyState = "pending" | "active" | "previous" | "retired";

export interface SigningKeysCopy {
  pageTitle: string;
  pageIntro: string;
  keysTitle: string;
  colKey: string;
  colState: string;
  colCreated: string;
  colSignsFrom: string;
  colRetired: string;
  state: Record<SigningKeyState, string>;
  stateHelp: Record<SigningKeyState, string>;
  policyTitle: string;
  policy(p: { leadHours: number; rotateDays: number; retireHours: number; scheduled: boolean }): string[];
  statusTitle: string;
  lastRun(when: string, trigger: "schedule" | "admin"): string;
  neverRun: string;
  queued(when: string): string;
  failedTitle: string;
  failedBody(when: string, attempts: number): string;
  retry: string;
  rotateNow: string;
  rotating: string;
  rotateOnlySuper: string;
  rotatePending: string;
  confirmTitle: string;
  confirmBody(leadHours: number, retireHours: number): string;
  confirm: string;
  cancel: string;
  queuedNotice: string;
  retryNotice: string;
  errors: Record<"super_admin_only" | "queue_unavailable" | "rate_limited" | "generic", string>;
  loadWhat: string;
  never: string;
}

const hours = (h: number, lang: AdminLang) =>
  lang === "ar" ? (h === 1 ? "ساعة واحدة" : h === 2 ? "ساعتين" : h <= 10 ? `${formatNumber(h, "ar")} ساعات` : `${formatNumber(h, "ar")} ساعة`) : `${h} hour${h === 1 ? "" : "s"}`;

const en: SigningKeysCopy = {
  pageTitle: "Signing keys",
  pageIntro: "The keys that sign sign-in tokens for every app. A new key is published before it signs, the previous key keeps working until its tokens have expired, then it is retired. Nobody is signed out.",
  keysTitle: "Keys",
  colKey: "Key ID",
  colState: "State",
  colCreated: "Created",
  colSignsFrom: "Signs from",
  colRetired: "Retired",
  state: { pending: "Published", active: "Signing", previous: "Previous", retired: "Retired" },
  stateHelp: {
    pending: "Apps already have it; it starts signing at the time shown.",
    active: "Signs every new token.",
    previous: "Signs nothing; its tokens still work until it is retired.",
    retired: "Removed: its tokens no longer work and its private key is deleted.",
  },
  policyTitle: "How rotation works",
  policy: ({ leadHours, rotateDays, retireHours, scheduled }) => [
    `A new key is published ${hours(leadHours, "en")} before it starts signing, so every app has it in time.`,
    `The previous key is retired ${hours(retireHours, "en")} after the new key starts signing, once every token it signed has expired.`,
    scheduled
      ? `A key is rotated automatically after ${rotateDays} days. You can also rotate now.`
      : "Automatic rotation is off in this environment: rotations start here. Retiring the previous key still happens on its own.",
  ],
  statusTitle: "Rotation job",
  lastRun: (when, trigger) => `Last run ${when} (${trigger === "admin" ? "asked for here" : "hourly check"}).`,
  neverRun: "Not run yet.",
  queued: (when) => `A rotation asked for at ${when} is waiting in the queue.`,
  failedTitle: "The last rotation step failed",
  failedBody: (when, attempts) => `It failed at ${when} after ${attempts} ${attempts === 1 ? "try" : "tries"}. The keys are unchanged; run the step again.`,
  retry: "Run again",
  rotateNow: "Rotate now",
  rotating: "Queuing…",
  rotateOnlySuper: "Only a Super Admin can rotate keys.",
  rotatePending: "A new key is already published. Rotate again once it signs.",
  confirmTitle: "Rotate the signing key now?",
  confirmBody: (leadHours, retireHours) =>
    `A new key is published now and starts signing in ${hours(leadHours, "en")}. The current key keeps working for ${hours(retireHours, "en")} after that, then it is retired. Nobody is signed out.`,
  confirm: "Rotate now",
  cancel: "Cancel",
  queuedNotice: "Rotation queued. The new key appears here within a minute.",
  retryNotice: "The step is queued again.",
  errors: {
    super_admin_only: "Only a Super Admin can rotate keys.",
    queue_unavailable: "The job queue is not available. The failure is shown below; try again later.",
    rate_limited: "Too many requests. Wait a minute and try again.",
    generic: "Something went wrong. Try again.",
  },
  loadWhat: "the signing keys",
  never: "—",
};

const ar: SigningKeysCopy = {
  pageTitle: "مفاتيح التوقيع",
  pageIntro: "المفاتيح التي توقّع رموز تسجيل الدخول لكل التطبيقات. يُنشَر المفتاح الجديد قبل أن يبدأ التوقيع، ويبقى المفتاح السابق صالحًا حتى تنتهي رموزه، ثم يُسحَب. لا يُسجَّل خروج أحد.",
  keysTitle: "المفاتيح",
  colKey: "معرّف المفتاح",
  colState: "الحالة",
  colCreated: "أُنشئ",
  colSignsFrom: "يوقّع من",
  colRetired: "سُحب",
  state: { pending: "منشور", active: "يوقّع", previous: "سابق", retired: "مسحوب" },
  stateHelp: {
    pending: "وصل إلى التطبيقات؛ يبدأ التوقيع في الوقت المعروض.",
    active: "يوقّع كل رمز جديد.",
    previous: "لا يوقّع شيئًا؛ تبقى رموزه صالحة حتى يُسحَب.",
    retired: "أُزيل: لم تعد رموزه صالحة وحُذف مفتاحه الخاص.",
  },
  policyTitle: "كيف يعمل التدوير",
  policy: ({ leadHours, rotateDays, retireHours, scheduled }) => [
    `يُنشَر المفتاح الجديد قبل ${hours(leadHours, "ar")} من بدء التوقيع، ليصل إلى كل التطبيقات في الوقت المناسب.`,
    `يُسحَب المفتاح السابق بعد ${hours(retireHours, "ar")} من بدء توقيع المفتاح الجديد، بعد انتهاء كل الرموز التي وقّعها.`,
    scheduled
      ? `يُدوَّر المفتاح تلقائيًا بعد ${formatNumber(rotateDays, "ar")} يومًا، ويمكنك التدوير الآن أيضًا.`
      : "التدوير التلقائي متوقف في هذه البيئة: يبدأ التدوير من هنا. أما سحب المفتاح السابق فيتم تلقائيًا.",
  ],
  statusTitle: "مهمة التدوير",
  lastRun: (when, trigger) => `آخر تشغيل ${when} (${trigger === "admin" ? "طُلب من هنا" : "الفحص كل ساعة"}).`,
  neverRun: "لم تُشغَّل بعد.",
  queued: (when) => `تدوير طُلب في ${when} ينتظر في قائمة المهام.`,
  failedTitle: "فشلت آخر خطوة تدوير",
  failedBody: (when, attempts) => `فشلت في ${when} بعد ${attempts === 1 ? "محاولة واحدة" : attempts === 2 ? "محاولتين" : `${attempts} محاولات`}. المفاتيح لم تتغير؛ شغّل الخطوة مرة أخرى.`,
  retry: "تشغيل مرة أخرى",
  rotateNow: "تدوير الآن",
  rotating: "جارٍ الإرسال…",
  rotateOnlySuper: "التدوير متاح للمشرف العام فقط.",
  rotatePending: "نُشر مفتاح جديد بالفعل. دوِّر مرة أخرى بعد أن يبدأ التوقيع.",
  confirmTitle: "تدوير مفتاح التوقيع الآن؟",
  confirmBody: (leadHours, retireHours) =>
    `يُنشَر مفتاح جديد الآن ويبدأ التوقيع بعد ${hours(leadHours, "ar")}. يبقى المفتاح الحالي صالحًا ${hours(retireHours, "ar")} بعد ذلك، ثم يُسحَب. لا يُسجَّل خروج أحد.`,
  confirm: "تدوير الآن",
  cancel: "إلغاء",
  queuedNotice: "أُرسل التدوير إلى قائمة المهام. يظهر المفتاح الجديد هنا خلال دقيقة.",
  retryNotice: "أُعيدت الخطوة إلى قائمة المهام.",
  errors: {
    super_admin_only: "التدوير متاح للمشرف العام فقط.",
    queue_unavailable: "قائمة المهام غير متاحة. يظهر الخطأ أدناه؛ حاول لاحقًا.",
    rate_limited: "طلبات كثيرة. انتظر دقيقة ثم حاول مرة أخرى.",
    generic: "حدث خطأ. حاول مرة أخرى.",
  },
  loadWhat: "مفاتيح التوقيع",
  never: "—",
};

export const signingKeysCopy = (lang: AdminLang): SigningKeysCopy => (lang === "ar" ? ar : en);
