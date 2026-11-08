/**
 * Shown when a page's data could not be loaded from the auth service (e.g. the
 * M2M client is misconfigured), so a failure is never mistaken for "no data".
 */
export function LoadErrorBanner({ what, error }: { what: string; error?: string | null }) {
  if (!error) return null;
  return (
    <div
      role="alert"
      className="mb-4 p-4 bg-destructive/10 border border-destructive/20 rounded-lg text-destructive"
    >
      <p className="font-semibold">Could not load {what}</p>
      <p className="text-sm mt-1 break-words">{error}</p>
    </div>
  );
}
