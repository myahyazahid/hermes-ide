import type { Locale } from "../shared/strings";

/** "5 minutes ago" / "kemarin" for session timestamps (ISO strings or epoch seconds). */
export function relativeTime(iso: string | undefined, locale: Locale, now = Date.now()): string {
  if (!iso) return "";
  const asNumber = Number(iso);
  const time = iso.trim() && Number.isFinite(asNumber) ? asNumber * 1000 : Date.parse(iso);
  if (Number.isNaN(time)) return "";
  const minutes = Math.round((now - time) / 60_000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (minutes < 60) return rtf.format(-Math.max(minutes, 0), "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return rtf.format(-hours, "hour");
  return rtf.format(-Math.round(hours / 24), "day");
}
