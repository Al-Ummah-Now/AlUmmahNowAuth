/**
 * System accounts in the Auth admin (auth src/security/system-accounts.ts).
 *
 * Placeholder users such as `user_system` only label automatic actions (the
 * `assigned_by` of the Member role every new account gets). The auth server
 * leaves them out of the user lists, search, counts and pickers, refuses every
 * sign-in and role grant for them, and flags each attempt on the admin Errors
 * page. Super admins see them, read-only, in the "System accounts" section of
 * Users (/users?view=system).
 *
 * The ids mirror openauth's SYSTEM_USER_IDS (user/system.ts); the admin app
 * does not bundle openauth.
 */
import type { AdminLang } from './deletion-copy';

export const SYSTEM_USER_IDS: readonly string[] = ['user_system'];

export function isSystemUserId(id: string | null | undefined): boolean {
  return typeof id === 'string' && SYSTEM_USER_IDS.includes(id);
}

/** 'Super Admin' / 'super_admin' / 'super-admin' */
export function isSuperAdmin(roles: readonly string[] | undefined): boolean {
  return (roles ?? []).some((r) => r.trim().toLowerCase().replace(/[\s-]+/g, '_') === 'super_admin');
}

export interface SystemAccountsCopy {
  automatic: string;
  title: string;
  description: string;
  cantSignIn: string;
  email: string;
  name: string;
  status: string;
  roles: string;
  noRoles: string;
  roleAlert: string;
  deleted: string;
  empty: string;
  show: string;
  hide: string;
}

const en: SystemAccountsCopy = {
  automatic: 'System (automatic)',
  title: 'System accounts',
  description:
    "Accounts that only label automatic actions, such as the Member role every new account gets. They can't sign in or hold roles, and they're left out of the user list. Every attempt to sign in as one or give one a role is refused and shows on the admin Errors page.",
  cantSignIn: "Can't sign in",
  email: 'Email',
  name: 'Name',
  status: 'Status',
  roles: 'Roles',
  noRoles: 'No roles',
  roleAlert: 'Holds a role it should not have. Remove it.',
  deleted: 'deleted',
  empty: 'No system accounts.',
  show: 'System accounts',
  hide: 'Back to users',
};

const ar: SystemAccountsCopy = {
  automatic: 'النظام (تلقائي)',
  title: 'حسابات النظام',
  description:
    'حسابات تُستخدم فقط لتسمية الإجراءات التلقائية، مثل دور «عضو» الذي يحصل عليه كل حساب جديد. لا يمكنها تسجيل الدخول ولا حمل أي دور، ولا تظهر في قائمة المستخدمين. تُرفض كل محاولة لتسجيل الدخول بها أو منحها دورًا، وتظهر في صفحة الأخطاء لدى المشرفين.',
  cantSignIn: 'لا يمكنه تسجيل الدخول',
  email: 'البريد الإلكتروني',
  name: 'الاسم',
  status: 'الحالة',
  roles: 'الأدوار',
  noRoles: 'لا أدوار',
  roleAlert: 'يحمل دورًا لا ينبغي أن يحمله. أزِله.',
  deleted: 'محذوف',
  empty: 'لا توجد حسابات نظام.',
  show: 'حسابات النظام',
  hide: 'العودة إلى المستخدمين',
};

export function systemAccountsCopy(lang: AdminLang): SystemAccountsCopy {
  return lang === 'ar' ? ar : en;
}

/**
 * How an "assigned by" / audit actor id is shown: a system account reads
 * "System (automatic)" (Arabic with ?lang=ar); a missing id too; anything else as is.
 */
export function actorLabel(id: string | null | undefined, lang: AdminLang): string {
  if (!id || id === 'system' || isSystemUserId(id)) return systemAccountsCopy(lang).automatic;
  return id;
}
