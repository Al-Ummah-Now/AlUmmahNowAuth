/**
 * Role names in Arabic, by the lower-cased name with spaces ("super admin"). Shared by Profile and the
 * Auth admin so a role reads the same everywhere; a role not listed shows its own name.
 */
export const ROLE_NAMES_AR: Record<string, string> = {
  admin: "مشرف",
  "super admin": "مشرف عام",
  member: "عضو",
  // the default role every account gets
  user: "مستخدم",
  moderator: "مراقب",
  scholar: "عالم",
  writer: "كاتب",
  creator: "صانع محتوى",
  "content reviewer": "مراجع محتوى",
  "senior reviewer": "مراجع أول",
};

/**
 * A role's name in the page language: "super_admin" → «مشرف عام» in Arabic and "Super admin" in English
 * (sentence case, as Profile shows roles); a role with no Arabic name keeps its own name.
 */
export function roleLabel(role: string, lang: string): string {
  const key = role.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (lang === "ar") return ROLE_NAMES_AR[key] ?? role;
  return key ? key.charAt(0).toUpperCase() + key.slice(1) : role;
}

/**
 * The built-in roles' descriptions in Arabic, by the English text the migrations seed
 * (apps/auth/migrations). A description an admin has changed is shown as written.
 */
export const ROLE_DESCRIPTIONS_AR: Record<string, string> = {
  "Administrative access": "صلاحيات الإدارة",
  "Basic member access": "صلاحيات العضو الأساسية",
  "Video platform content moderation": "الإشراف على محتوى منصة المرئيات",
  "Writes and edits Al Ummah Now": "يكتب ويحرّر محتوى الأمة الآن",
  "Writes articles in the CMS (own posts only) for their scholar page on www": "يكتب مقالات في نظام إدارة المحتوى (منشوراته فقط) لصفحته العلمية على الموقع",
  "Decides videos and images held by pre-publication review (not escalations)": "يقرّر في المرئيات والصور المعلّقة في المراجعة قبل النشر (دون الحالات المصعّدة)",
  "Decides held items including escalations, minor-present items and appeals": "يقرّر في العناصر المعلّقة، ومنها الحالات المصعّدة والعناصر التي يظهر فيها قاصرون والطعون",
};

/** A role's description in the page language: a built-in role's seeded text in Arabic, anything else as written. */
export function roleDescription(description: string | null | undefined, lang: string): string {
  if (!description) return "";
  return lang === "ar" ? ROLE_DESCRIPTIONS_AR[description.trim()] ?? description : description;
}
