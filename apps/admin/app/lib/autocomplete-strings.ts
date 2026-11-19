/** The user picker's words (components/autocomplete.tsx), in English and Arabic. Numbers in ٠–٩ in Arabic. */
import { formatNumber } from "../../../../packages/ui/src/format.ts";

const en = {
  searchPlaceholder: "Type a name or email",
  pickPlaceholder: "Name, email or user ID",
  searching: "Searching…",
  loadingList: "Loading the newest users…",
  emptyList: "No users yet.",
  listFailed: "Couldn’t load the list.",
  retry: "Try again",
  loadingMore: "Loading more…",
  current: "Current",
  recent: (n: number) => `Newest ${n} users. Type to search, or scroll for more.`,
  noMatches: "No matches. Press Enter to search anyway.",
  failed: "Suggestions are unavailable right now. Press Enter to search.",
  count: (n: number) => `${n} suggestion${n === 1 ? "" : "s"}. Use the up and down arrows to choose, Enter to open.`,
  searchAll: "Search everything for",
  useId: "Use this user ID:",
  lookingUp: "Looking up…",
  notFound: "No user has this ID",
  change: "Change",
  changeLabel: (name: string) => `Change the user (${name})`,
  clearLabel: (name: string) => `Remove the chosen user (${name})`,
};

export type AutocompleteStrings = typeof en;

const N = (n: number) => formatNumber(n, "ar");

const ar: AutocompleteStrings = {
  searchPlaceholder: "اكتب اسمًا أو بريدًا إلكترونيًا",
  pickPlaceholder: "الاسم أو البريد الإلكتروني أو معرّف المستخدم",
  searching: "جارٍ البحث…",
  loadingList: "جارٍ تحميل أحدث المستخدمين…",
  emptyList: "لا يوجد مستخدمون بعد.",
  listFailed: "تعذّر تحميل القائمة.",
  retry: "حاول مرة أخرى",
  loadingMore: "جارٍ تحميل المزيد…",
  current: "الحالي",
  recent: (n: number) => `أحدث المستخدمين (${N(n)}). اكتب للبحث، أو مرّر لرؤية المزيد.`,
  noMatches: "لا نتائج. اضغط Enter للبحث على أي حال.",
  failed: "الاقتراحات غير متاحة الآن. اضغط Enter للبحث.",
  count: (n: number) => `الاقتراحات: ${N(n)}. استخدم السهمين لأعلى ولأسفل للاختيار، وEnter للفتح.`,
  searchAll: "البحث في كل شيء عن",
  useId: "استخدام معرّف المستخدم هذا:",
  lookingUp: "جارٍ البحث…",
  notFound: "لا يوجد مستخدم بهذا المعرّف",
  change: "تغيير",
  changeLabel: (name: string) => `تغيير المستخدم (${name})`,
  clearLabel: (name: string) => `إزالة المستخدم المختار (${name})`,
};

export const autocompleteStrings = (lang: "en" | "ar"): AutocompleteStrings => (lang === "ar" ? ar : en);

/** English (the default for pages written only in English). */
export const AUTOCOMPLETE_STRINGS = en;
