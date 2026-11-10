/**
 * Words for the admin's other confirmation dialogs (moderation decisions,
 * ending a session, rotating a client secret, removing a theme file or a
 * user's role), in English and Arabic. Same rule as deletion-copy: English
 * is the default; ?lang=ar shows Arabic (right-to-left).
 */
import type { AdminLang } from './deletion-copy';

export { dirOf, langOf, type AdminLang } from './deletion-copy';

export interface DialogCopy {
  title: string;
  body: string;
  confirm: string;
}

export interface ConfirmCopy {
  cancel: string;
  approve: DialogCopy;
  execute: DialogCopy;
  /** Added to a moderation dialog when the action deletes the account. */
  deletesAccount(email: string): string;
  endSession: Omit<DialogCopy, 'body'> & { body(email: string): string };
  endSessionButton: string;
  endSessionAria(email: string): string;
  rotateSecret: Omit<DialogCopy, 'body'> & { body(name: string, clientId: string): string };
  removeFile: Omit<DialogCopy, 'body'> & { body(file: string): string };
  removeRole: Omit<DialogCopy, 'body'> & { body(email: string, role: string): string };
}

const en: ConfirmCopy = {
  cancel: 'Cancel',
  approve: {
    title: 'Approve this request?',
    body: 'Its action is queued and runs on the auth account within seconds.',
    confirm: 'Approve',
  },
  execute: {
    title: 'Run the action again?',
    body: 'The action is queued on the auth account again.',
    confirm: 'Run action again',
  },
  deletesAccount: (email) =>
    `This deletes the account of ${email}: it is signed out everywhere and moves to Recently deleted, restorable for 30 days.`,
  endSession: {
    title: 'End this session?',
    body: (email) => `${email} is signed out on that device and has to sign in again there.`,
    confirm: 'End session',
  },
  endSessionButton: 'End this session',
  endSessionAria: (email) => `End session of ${email}`,
  rotateSecret: {
    title: 'Rotate the client secret?',
    body: (name, clientId) =>
      `The current secret of "${name}" (${clientId}) stops working at once. The app cannot get tokens until it is given the new secret.`,
    confirm: 'Rotate secret',
  },
  removeFile: {
    title: 'Remove this file?',
    body: (file) => `${file} is removed from the theme. Anything that uses it stops showing it.`,
    confirm: 'Remove file',
  },
  removeRole: {
    title: 'Remove this role?',
    body: (email, role) => `${email} loses the "${role}" role and every permission it grants.`,
    confirm: 'Remove role',
  },
};

const ar: ConfirmCopy = {
  cancel: 'إلغاء',
  approve: {
    title: 'الموافقة على هذا الطلب؟',
    body: 'يُضاف إجراؤه إلى قائمة الانتظار ويُنفَّذ على الحساب خلال ثوانٍ.',
    confirm: 'موافقة',
  },
  execute: {
    title: 'تشغيل الإجراء مرة أخرى؟',
    body: 'يُضاف الإجراء إلى قائمة الانتظار على الحساب مرة أخرى.',
    confirm: 'تشغيل الإجراء مرة أخرى',
  },
  deletesAccount: (email) =>
    `يحذف هذا حساب ${email}: يُسجَّل خروجه من كل مكان وينتقل إلى المحذوفات مؤخرًا، ويمكن استعادته خلال 30 يومًا.`,
  endSession: {
    title: 'إنهاء هذه الجلسة؟',
    body: (email) => `يُسجَّل خروج ${email} على ذلك الجهاز ويلزمه تسجيل الدخول مجددًا هناك.`,
    confirm: 'إنهاء الجلسة',
  },
  endSessionButton: 'إنهاء هذه الجلسة',
  endSessionAria: (email) => `إنهاء جلسة ${email}`,
  rotateSecret: {
    title: 'تغيير السر الخاص بالعميل؟',
    body: (name, clientId) =>
      `يتوقف السر الحالي لـ "${name}" (${clientId}) عن العمل فورًا. لا يستطيع التطبيق الحصول على رموز حتى يُعطى السر الجديد.`,
    confirm: 'تغيير السر',
  },
  removeFile: {
    title: 'إزالة هذا الملف؟',
    body: (file) => `يُزال ${file} من السمة. كل ما يستخدمه يتوقف عن عرضه.`,
    confirm: 'إزالة الملف',
  },
  removeRole: {
    title: 'إزالة هذا الدور؟',
    body: (email, role) => `يفقد ${email} الدور "${role}" وكل صلاحية يمنحها.`,
    confirm: 'إزالة الدور',
  },
};

export const confirmCopy = (lang: AdminLang): ConfirmCopy => (lang === 'ar' ? ar : en);
