import { useSearchParams } from "react-router";
import { adminCopy } from "../lib/admin-copy";
import { langOf } from "../lib/deletion-copy";

/**
 * Shown when a page's data could not be loaded from the auth service (e.g. the
 * M2M client is misconfigured), so a failure is never mistaken for "no data".
 * The title follows the page language (?lang=ar).
 */
export function LoadErrorBanner({ what, title, error }: { what?: string; title?: string; error?: string | null }) {
  const [searchParams] = useSearchParams();
  if (!error) return null;
  const c = adminCopy(langOf(searchParams)).common;
  return (
    <div
      role="alert"
      className="mb-4 p-4 bg-destructive/10 border border-destructive/20 rounded-lg text-destructive"
    >
      <p className="font-semibold">{title ?? (what ? c.couldNotLoad(what) : c.couldNotLoadPage)}</p>
      {/* The service's own message (English) */}
      <p className="text-sm mt-1 break-words" dir="auto">{error}</p>
    </div>
  );
}
