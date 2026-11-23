/**
 * Every date and time in the admin, one way (owner, 2026-11-21): the viewer's local time with its
 * zone, UTC on hover. "Nov 5, 2026, 7:00 AM EST" / «٥ نوفمبر ٢٠٢٦، ٢:٠٠ ص غرينتش-٥»; UTC reads
 * «بالتوقيت العالمي» in Arabic. The server render has no viewer zone, so it shows UTC until the
 * browser takes over (after hydration: no mismatch). Numbers through packages/ui/src/format.ts.
 */
import { useSyncExternalStore } from "react";
import { formatDate } from "../../../../packages/ui/src/format.ts";

type Lang = "en" | "ar";
type Value = string | number | Date | null | undefined;

const noSubscribe = () => () => {};
/** false in the server render and while hydrating, true after. */
export const useInBrowser = () => useSyncExternalStore(noSubscribe, () => true, () => false);

/** Unix seconds (a number under 1e11) or ms / ISO. */
const toMs = (v: Value): number | null => {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v < 1e11 ? v * 1000 : v;
  const n = Date.parse(v);
  return Number.isNaN(n) ? null : n;
};

/** The date: "Nov 5, 2026" / «٥ نوفمبر ٢٠٢٦» (no padded or slashed forms). */
export function adminDate(v: Value, lang: Lang, timeZone?: string): string {
  const ms = toMs(v);
  if (ms === null) return "";
  return lang === "ar"
    ? formatDate(ms, "ar", { day: "numeric", month: "long", year: "numeric", timeZone })
    : formatDate(ms, "en", { dateStyle: "medium", timeZone }, "en-US");
}

/** The time with its zone: "7:00 AM UTC" / «٧:٠٠ ص بالتوقيت العالمي». */
export function adminClock(v: Value, lang: Lang, timeZone?: string): string {
  const ms = toMs(v);
  if (ms === null) return "";
  const s = formatDate(ms, lang, { hour: "numeric", minute: "2-digit", timeZone, timeZoneName: "short" }, "en-US");
  return lang === "ar" ? s.replace(/\bUTC\b|غرينتش$/, "بالتوقيت العالمي") : s;
}

/** Date and time in one string (for sentences); `utc` forces UTC (the server render). */
export function adminStamp(v: Value, lang: Lang, utc: boolean, dateOnly = false): string {
  const zone = utc ? "UTC" : undefined;
  const date = adminDate(v, lang, zone);
  if (!date || dateOnly) return date;
  return date + (lang === "ar" ? "، " : ", ") + adminClock(v, lang, zone);
}

/** For times inside sentences: a formatter that switches to local time after hydration. */
export function useAdminTime(lang: Lang) {
  const inBrowser = useInBrowser();
  return (v: Value, dateOnly = false) => adminStamp(v, lang, !inBrowser, dateOnly);
}

/** A date (and time) on its own: <time>, local in the browser, UTC on hover. The time never wraps. */
export function AdminTime({ value, lang, dateOnly = false, missing = "—" }: { value: Value; lang: Lang; dateOnly?: boolean; missing?: string }) {
  const inBrowser = useInBrowser();
  const ms = toMs(value);
  if (ms === null) return <>{missing}</>;
  const utc = adminStamp(ms, lang, true, dateOnly);
  const zone = inBrowser ? undefined : "UTC";
  return (
    <time dateTime={new Date(ms).toISOString()} title={utc}>
      <span className="whitespace-nowrap">{adminDate(ms, lang, zone)}</span>
      {dateOnly ? null : (
        <>
          {lang === "ar" ? "، " : ", "}
          <span className="whitespace-nowrap">{adminClock(ms, lang, zone)}</span>
        </>
      )}
    </time>
  );
}
