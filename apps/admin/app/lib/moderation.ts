import { formatDateTimeMs } from "./date-utils";
import { ADMIN_COPY } from "./admin-copy";
import type { AdminLang } from "./deletion-copy";
import { withLang } from "./shell-copy";
/** Labels shared by the moderation request pages (docs/MODERATION_REQUESTS.md). */

// The English labels; Arabic ones are in lib/admin-copy.ts (adminCopy(lang).moderationLabels)
export const MODERATION_STATUS_LABELS: Record<string, string> = ADMIN_COPY.en.moderationLabels.status;
export const MODERATION_ACTION_LABELS: Record<string, string> = ADMIN_COPY.en.moderationLabels.action;
export const REASON_CATEGORY_LABELS: Record<string, string> = ADMIN_COPY.en.moderationLabels.reason;

/** Badge colours per status (tailwind classes on the shared Badge). */
export const MODERATION_STATUS_CLASSES: Record<string, string> = {
  pending: "bg-amber-500/15 text-amber-800 dark:text-amber-300 border-amber-500/30",
  info_requested: "bg-sky-500/15 text-sky-800 dark:text-sky-300 border-sky-500/30",
  approved: "bg-indigo-500/15 text-indigo-800 dark:text-indigo-300 border-indigo-500/30",
  rejected: "bg-zinc-500/15 text-zinc-800 dark:text-zinc-300 border-zinc-500/30",
  actioned: "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 border-emerald-500/30",
};

export const label = (map: Record<string, string>, key: string) => map[key] ?? key;

export function formatWhen(value: string | number | null | undefined, lang: AdminLang = "en"): string {
  if (!value) return "—";
  return formatDateTimeMs(value, lang) || String(value);
}

/** The Users page, searching for this user. */
export function userPageHref(subject: { email?: string | null; id: string }, lang: AdminLang = "en"): string {
  return withLang(`/users?q=${encodeURIComponent(subject.email || subject.id)}`, lang);
}
