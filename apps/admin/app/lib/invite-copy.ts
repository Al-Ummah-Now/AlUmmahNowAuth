import type { AdminLang } from "./deletion-copy";

export const USER_STATUSES = ["active", "invited", "suspended"] as const;
export const INVITE_STATUSES = ["pending", "accepted", "expired", "revoked"] as const;

const copy = {
  en: {
    title: "Invites",
    status: "Status",
    all: "All statuses",
    userStatuses: { active: "Active", invited: "Invited", suspended: "Suspended", deleted: "Deleted", disabled: "Disabled" },
    inviteStatuses: { pending: "Pending", accepted: "Accepted", expired: "Expired", revoked: "Revoked" },
    view: "View invites",
    search: "Search invites",
    apply: "Apply filters",
    empty: "No invites match these filters.",
    inviter: "Invited by",
    client: "Source app",
    created: "Created",
    expires: "Expires",
    revoke: "Revoke",
    revokeTitle: "Revoke invite?",
    revokeBody: "This withdraws the invite and moves the unused account to Recently deleted.",
    revoked: "Invite revoked.",
    invalid: "Invalid invite action.",
    first: "First page",
    next: "Next page",
  },
  ar: {
    title: "الدعوات",
    status: "الحالة",
    all: "جميع الحالات",
    userStatuses: { active: "نشط", invited: "مدعو", suspended: "معلّق", deleted: "محذوف", disabled: "معطّل" },
    inviteStatuses: { pending: "قيد الانتظار", accepted: "مقبولة", expired: "منتهية", revoked: "ملغاة" },
    view: "عرض الدعوات",
    search: "البحث في الدعوات",
    apply: "تطبيق عوامل التصفية",
    empty: "لا توجد دعوات تطابق عوامل التصفية.",
    inviter: "الداعي",
    client: "التطبيق المصدر",
    created: "تاريخ الإنشاء",
    expires: "تاريخ الانتهاء",
    revoke: "إلغاء الدعوة",
    revokeTitle: "هل تريد إلغاء الدعوة؟",
    revokeBody: "سيؤدي ذلك إلى سحب الدعوة ونقل الحساب غير المستخدم إلى المحذوفة مؤخرًا.",
    revoked: "أُلغيت الدعوة.",
    invalid: "إجراء الدعوة غير صالح.",
    first: "الصفحة الأولى",
    next: "الصفحة التالية",
  },
};

export const inviteCopy = (lang: AdminLang) => copy[lang];
