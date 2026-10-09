import type { Locale } from "../../src/shared/strings";

export function relativePath(p: string, cwd: string | undefined): string {
  if (!cwd) return p;
  const norm = (s: string) => s.replace(/\\/g, "/");
  const a = norm(p);
  const base = norm(cwd).replace(/\/$/, "") + "/";
  return a.toLowerCase().startsWith(base.toLowerCase()) ? a.slice(base.length) : a;
}

export function formatSeconds(ms: number, locale: Locale): string {
  const s = ms / 1000;
  const n = s < 10 ? s.toFixed(1) : Math.round(s).toString();
  return `${locale === "id" ? n.replace(".", ",") : n} ${locale === "id" ? "dtk" : "s"}`;
}

export function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return String(n);
}
