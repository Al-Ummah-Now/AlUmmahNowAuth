/**
 * Words for admin soft delete: the delete, restore and "delete permanently now"
 * dialogs and the Recently deleted page, in English and Arabic. English is the
 * default; ?lang=ar shows Arabic (right-to-left).
 */

export type AdminLang = 'en' | 'ar';
export type DeletionKind = 'user' | 'client' | 'role' | 'theme';

export const RETENTION_DAYS = 30;

export const langOf = (search: string | URLSearchParams | null | undefined): AdminLang => {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  return params?.get('lang') === 'ar' ? 'ar' : 'en';
};

export const dirOf = (lang: AdminLang) => (lang === 'ar' ? 'rtl' : 'ltr');

const KIND = {
  en: { user: 'user', client: 'OAuth client', role: 'role', theme: 'theme' },
  ar: { user: 'المستخدم', client: 'عميل OAuth', role: 'الدور', theme: 'السمة' },
} as const;

const TAB = {
  en: { user: 'Users', client: 'OAuth clients', role: 'Roles', theme: 'Sign-in themes' },
  ar: { user: 'المستخدمون', client: 'عملاء OAuth', role: 'الأدوار', theme: 'سمات تسجيل الدخول' },
} as const;

export interface DeletionCopy {
  kindName(kind: DeletionKind): string;
  tab(kind: DeletionKind): string;
  cancel: string;
  reasonLabel: string;
  reasonPlaceholder: string;
  deleteTitle(kind: DeletionKind): string;
  deleteBody(kind: DeletionKind, label: string): string;
  deleteConfirm: string;
  roleHolders(count: number): string;
  restoreTitle(kind: DeletionKind): string;
  restoreBody(label: string): string;
  restoreConfirm: string;
  purgeTitle: string;
  purgeBody(label: string): string;
  purgeTypeLabel(label: string): string;
  purgeConfirm: string;
  pageTitle: string;
  pageIntro: string;
  empty(kind: DeletionKind): string;
  colItem: string;
  colDeletedBy: string;
  colDeletedAt: string;
  colReason: string;
  colRemoval: string;
  colActions: string;
  daysLeft(days: number): string;
  queued: string;
  lastError(error: string): string;
  restore: string;
  deletePermanently: string;
  restored: string;
  queuedNotice: string;
  self: string;
  moderation: string;
  unknownActor: string;
}

const en: DeletionCopy = {
  kindName: (k) => KIND.en[k],
  tab: (k) => TAB.en[k],
  cancel: 'Cancel',
  reasonLabel: 'Reason (optional)',
  reasonPlaceholder: 'Why is this being deleted?',
  deleteTitle: (k) => `Delete ${KIND.en[k]}`,
  deleteBody: (k, label) =>
    `"${label}" moves to Recently deleted and stops working at once. It can be restored for ${RETENTION_DAYS} days; after that it is deleted permanently.` +
    (k === 'user' ? ' The user is signed out everywhere.' : ''),
  deleteConfirm: 'Delete',
  roleHolders: (n) => ` ${n === 1 ? '1 user holds' : `${n} users hold`} this role; they lose it now and get it back if the role is restored.`,
  restoreTitle: (k) => `Restore ${KIND.en[k]}`,
  restoreBody: (label) => `Restore "${label}"? It comes back exactly as it was before it was deleted.`,
  restoreConfirm: 'Restore',
  purgeTitle: 'Delete permanently',
  purgeBody: (label) =>
    `"${label}" will be deleted permanently on the next cleanup run (within the hour). This cannot be undone once the cleanup has run.`,
  purgeTypeLabel: (label) => `Type "${label}" to confirm`,
  purgeConfirm: 'Delete permanently',
  pageTitle: 'Recently deleted',
  pageIntro: `Deleted items stay here for ${RETENTION_DAYS} days and can be restored. After that, or once you choose "Delete permanently", the hourly cleanup removes them for good.`,
  empty: (k) => `No deleted ${TAB.en[k].toLowerCase()}.`,
  colItem: 'Item',
  colDeletedBy: 'Deleted by',
  colDeletedAt: 'Deleted',
  colReason: 'Reason',
  colRemoval: 'Permanent deletion',
  colActions: 'Actions',
  daysLeft: (d) => (d <= 0 ? 'On the next cleanup run' : d === 1 ? 'In 1 day' : `In ${d} days`),
  queued: 'Queued for permanent deletion',
  lastError: (e) => `Last cleanup attempt failed: ${e}`,
  restore: 'Restore',
  deletePermanently: 'Delete permanently',
  restored: 'Restored.',
  queuedNotice: 'Queued for permanent deletion on the next cleanup run.',
  self: 'The account owner',
  moderation: 'Moderation request',
  unknownActor: 'Unknown',
};

const ar: DeletionCopy = {
  kindName: (k) => KIND.ar[k],
  tab: (k) => TAB.ar[k],
  cancel: 'إلغاء',
  reasonLabel: 'السبب (اختياري)',
  reasonPlaceholder: 'لماذا يُحذف هذا العنصر؟',
  deleteTitle: (k) => `حذف ${KIND.ar[k]}`,
  deleteBody: (k, label) =>
    `ينتقل "${label}" إلى المحذوفات مؤخرًا ويتوقف عن العمل فورًا. يمكن استعادته خلال ${RETENTION_DAYS} يومًا، وبعدها يُحذف نهائيًا.` +
    (k === 'user' ? ' ويُسجَّل خروج المستخدم من كل الأجهزة.' : ''),
  deleteConfirm: 'حذف',
  roleHolders: (n) => ` يحمل هذا الدور ${n === 1 ? 'مستخدم واحد' : `${n} من المستخدمين`}؛ يفقدونه الآن ويستعيدونه إذا استُعيد الدور.`,
  restoreTitle: (k) => `استعادة ${KIND.ar[k]}`,
  restoreBody: (label) => `استعادة "${label}"؟ سيعود كما كان قبل حذفه تمامًا.`,
  restoreConfirm: 'استعادة',
  purgeTitle: 'حذف نهائي',
  purgeBody: (label) => `سيُحذف "${label}" نهائيًا في تشغيل التنظيف التالي (خلال ساعة). لا يمكن التراجع عن ذلك بعد تشغيل التنظيف.`,
  purgeTypeLabel: (label) => `اكتب "${label}" للتأكيد`,
  purgeConfirm: 'حذف نهائي',
  pageTitle: 'المحذوفات مؤخرًا',
  pageIntro: `تبقى العناصر المحذوفة هنا ${RETENTION_DAYS} يومًا ويمكن استعادتها. بعد ذلك، أو عند اختيار "حذف نهائي"، يزيلها التنظيف الذي يعمل كل ساعة نهائيًا.`,
  empty: (k) => `لا توجد عناصر محذوفة في ${TAB.ar[k]}.`,
  colItem: 'العنصر',
  colDeletedBy: 'حذفه',
  colDeletedAt: 'تاريخ الحذف',
  colReason: 'السبب',
  colRemoval: 'الحذف النهائي',
  colActions: 'الإجراءات',
  daysLeft: (d) => (d <= 0 ? 'في تشغيل التنظيف التالي' : d === 1 ? 'بعد يوم واحد' : d === 2 ? 'بعد يومين' : d <= 10 ? `بعد ${d} أيام` : `بعد ${d} يومًا`),
  queued: 'في قائمة الحذف النهائي',
  lastError: (e) => `فشلت آخر محاولة تنظيف: ${e}`,
  restore: 'استعادة',
  deletePermanently: 'حذف نهائي',
  restored: 'تمت الاستعادة.',
  queuedNotice: 'أُضيف إلى قائمة الحذف النهائي في تشغيل التنظيف التالي.',
  self: 'صاحب الحساب',
  moderation: 'طلب إشراف',
  unknownActor: 'غير معروف',
};

export const deletionCopy = (lang: AdminLang): DeletionCopy => (lang === 'ar' ? ar : en);

/** Whole days until the cleanup removes the item (0 = on the next run). */
export function daysUntil(purgeAt: number, now: number): number {
  return Math.max(0, Math.ceil((purgeAt - now) / (24 * 60 * 60 * 1000)));
}
