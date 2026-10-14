import type { Locale } from "../shared/strings";

/** Session timestamps arrive as ISO strings or epoch seconds; returns epoch ms. */
export function parseSessionTime(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const asNumber = Number(iso);
  const time = iso.trim() && Number.isFinite(asNumber) ? asNumber * 1000 : Date.parse(iso);
  return Number.isNaN(time) ? undefined : time;
}

/** Claude-style "now" / "5m" / "3h" / "2d" for the history popover. */
export function compactTime(ms: number | undefined, locale: Locale, now = Date.now()): string {
  if (ms === undefined) return "";
  const minutes = Math.floor((now - ms) / 60_000);
  if (minutes < 1) return locale === "id" ? "baru" : "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return locale === "id" ? `${hours}j` : `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return locale === "id" ? `${days}h` : `${days}d`;
  return new Date(ms).toLocaleDateString(locale === "id" ? "id-ID" : "en-US", { day: "numeric", month: "short" });
}

/** "5 minutes ago" / "kemarin" for session timestamps (ISO strings or epoch seconds). */
export function relativeTime(iso: string | undefined, locale: Locale, now = Date.now()): string {
  const time = parseSessionTime(iso);
  if (time === undefined) return "";
  const minutes = Math.round((now - time) / 60_000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (minutes < 60) return rtf.format(-Math.max(minutes, 0), "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return rtf.format(-hours, "hour");
  return rtf.format(-Math.round(hours / 24), "day");
}
