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

/** A role's name in the page language: "Super_Admin" → «مشرف عام» in Arabic, unchanged in English. */
export function roleLabel(role: string, lang: string): string {
  if (lang !== "ar") return role;
  return ROLE_NAMES_AR[role.toLowerCase().replace(/[_-]+/g, " ").trim()] ?? role;
}
