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

const UPPER: Record<string, string> = { gpt: "GPT", glm: "GLM", qwq: "QwQ", oss: "OSS", vl: "VL", ai: "AI", hd: "HD", llm: "LLM", api: "API" };

/**
 * "claude-opus-4-5-20251101" → { name: "Claude Opus 4.5", date: "20251101" };
 * "gemini-3.8-flash-high" → "Gemini 3.8 Flash High". The raw id stays visible next to it.
 */
export function prettyModelName(raw: string): { name: string; date?: string } {
  // "Custom endpoint · customer-service": the endpoint name is shown as the group already.
  let base = raw.split(" · ").pop() ?? raw;
  base = base.slice(base.lastIndexOf("/") + 1);
  base = base.slice(base.lastIndexOf(":") + 1);
  const dated = /[-_@](\d{8})$/.exec(base);
  if (dated) base = base.slice(0, dated.index);
  const words: string[] = [];
  for (const token of base.split(/[-_\s]+/).filter(Boolean)) {
    const prev = words[words.length - 1];
    // "4-5" is version 4.5, not two words.
    if (/^\d{1,2}$/.test(token) && prev && /^\d{1,2}(\.\d{1,2})?$/.test(prev) && !prev.includes(".")) {
      words[words.length - 1] = `${prev}.${token}`;
      continue;
    }
    const lower = token.toLowerCase();
    words.push(UPPER[lower] ?? (/^[a-z]/.test(token) ? token[0].toUpperCase() + token.slice(1) : token));
  }
  return { name: words.join(" ") || raw, date: dated?.[1] };
}

/**
 * File name plus a short folder for cards: workspace files keep their relative folder,
 * files elsewhere keep only the last two folders ("…/cache/scratch").
 */
export function splitPath(p: string, cwd: string | undefined): { name: string; dir: string } {
  const rel = relativePath(p, cwd).replace(/\\/g, "/");
  const parts = rel.split("/").filter(Boolean);
  const name = parts.pop() ?? rel;
  const outside = /^([a-zA-Z]:|\/)/.test(rel);
  const dir = outside && parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : parts.join("/");
  return { name, dir };
}

export function shortPath(p: string, cwd: string | undefined): string {
  const { name, dir } = splitPath(p, cwd);
  return dir ? `${dir}/${name}` : name;
}
