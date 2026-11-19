/**
 * Role names in Arabic, by the lower-cased name with spaces ("super admin"). Shared by Profile and the
 * Auth admin so a role reads the same everywhere; a role not listed shows its own name.
 */
export const ROLE_NAMES_AR: Record<string, string> = {
  admin: "مشرف",
  "super admin": "مشرف عام",
  member: "عضو",
  moderator: "مراقب",
  scholar: "عالم",
  writer: "كاتب",
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
