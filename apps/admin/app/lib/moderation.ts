/** Labels shared by the moderation request pages (docs/MODERATION_REQUESTS.md). */

export const MODERATION_STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  info_requested: "Info requested",
  approved: "Approved",
  rejected: "Rejected",
  actioned: "Actioned",
};

export const MODERATION_ACTION_LABELS: Record<string, string> = {
  suspend_account: "Suspend account",
  delete_account: "Delete account",
  revoke_sessions: "Sign out everywhere",
  require_password_reset: "Require password reset",
  other: "Other",
};

export const REASON_CATEGORY_LABELS: Record<string, string> = {
  spam: "Spam",
  harassment: "Harassment",
  hate_speech: "Hate speech",
  violent_content: "Violent content",
  sexual_content: "Sexual content",
  impersonation: "Impersonation",
  copyright: "Copyright",
  fraud: "Fraud",
  compromised_account: "Compromised account",
  other: "Other",
};

/** Badge colours per status (tailwind classes on the shared Badge). */
export const MODERATION_STATUS_CLASSES: Record<string, string> = {
  pending: "bg-amber-500/15 text-amber-600 border-amber-500/30",
  info_requested: "bg-sky-500/15 text-sky-600 border-sky-500/30",
  approved: "bg-indigo-500/15 text-indigo-600 border-indigo-500/30",
  rejected: "bg-zinc-500/15 text-zinc-600 border-zinc-500/30",
  actioned: "bg-emerald-500/15 text-emerald-600 border-emerald-500/30",
};

export const label = (map: Record<string, string>, key: string) => map[key] ?? key;

export function formatWhen(value: string | number | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

/** The Users page, searching for this user. */
export function userPageHref(subject: { email?: string | null; id: string }): string {
  return `/users?q=${encodeURIComponent(subject.email || subject.id)}`;
}
