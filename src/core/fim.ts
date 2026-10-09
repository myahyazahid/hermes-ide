// Tab autocomplete (F-17) talks to a separate fill-in-the-middle model, outside Hermes. Most
// self-hosted servers (vLLM, llama.cpp, Ollama, LM Studio) expose OpenAI-style /v1/completions;
// either the server applies FIM itself from `prompt` + `suffix`, or we build the prompt with the
// model family's FIM tokens.
import { normalizeBaseUrl } from "./endpoint";

export type FimTemplate = "auto" | "suffix" | "qwen" | "starcoder" | "codellama" | "deepseek";

export interface FimEndpoint {
  baseUrl: string;
  model: string;
  apiKey?: string;
  template: FimTemplate;
  maxTokens: number;
}

interface TemplateSpec {
  build(prefix: string, suffix: string): string;
  /** Tokens that end a completion if the server does not strip them. */
  stops: string[];
}

const TEMPLATES: Record<Exclude<FimTemplate, "auto" | "suffix">, TemplateSpec> = {
  qwen: {
    build: (p, s) => `<|fim_prefix|>${p}<|fim_suffix|>${s}<|fim_middle|>`,
    stops: ["<|endoftext|>", "<|fim_prefix|>", "<|fim_suffix|>", "<|fim_middle|>", "<|fim_pad|>", "<|file_sep|>", "<|im_end|>"],
  },
  starcoder: {
    build: (p, s) => `<fim_prefix>${p}<fim_suffix>${s}<fim_middle>`,
    stops: ["<|endoftext|>", "<fim_prefix>", "<fim_suffix>", "<fim_middle>", "<file_sep>"],
  },
  codellama: {
    build: (p, s) => `<PRE> ${p} <SUF>${s} <MID>`,
    stops: ["<EOT>", "<PRE>", "<SUF>", "<MID>"],
  },
  deepseek: {
    build: (p, s) => `<｜fim▁begin｜>${p}<｜fim▁hole｜>${s}<｜fim▁end｜>`,
    stops: ["<｜fim▁begin｜>", "<｜fim▁hole｜>", "<｜fim▁end｜>", "<|EOT|>", "<｜end▁of▁sentence｜>"],
  },
};

/** Picks the FIM token format from the model name; unknown models use the server's `suffix`. */
export function resolveTemplate(template: FimTemplate, model: string): Exclude<FimTemplate, "auto"> {
  if (template !== "auto") return template;
  const m = model.toLowerCase();
  if (m.includes("qwen") && m.includes("coder")) return "qwen";
  if (m.includes("starcoder") || m.includes("stable-code") || m.includes("santacoder")) return "starcoder";
  if (m.includes("codellama") || m.includes("code-llama")) return "codellama";
  if (m.includes("deepseek") && m.includes("coder")) return "deepseek";
  return "suffix";
}

export interface FimRequest {
  url: string;
  body: Record<string, unknown>;
  stops: string[];
}

export function buildFimRequest(ep: FimEndpoint, prefix: string, suffix: string, multiline: boolean): FimRequest {
  const template = resolveTemplate(ep.template, ep.model);
  const lineStops = multiline ? ["\n\n\n"] : ["\n"];
  const base = {
    model: ep.model,
    max_tokens: multiline ? ep.maxTokens : Math.min(ep.maxTokens, 48),
    temperature: 0.1,
    top_p: 0.95,
    stream: false,
  };
  const url = `${normalizeBaseUrl(ep.baseUrl)}/completions`;
  if (template === "suffix") {
    return { url, body: { ...base, prompt: prefix, suffix, stop: lineStops }, stops: [] };
  }
  const spec = TEMPLATES[template];
  // OpenAI-compatible servers accept at most 4 stop strings; the rest are cut client-side.
  return { url, body: { ...base, prompt: spec.build(prefix, suffix), stop: [...lineStops, ...spec.stops].slice(0, 4) }, stops: spec.stops };
}

/**
 * Cleans a raw completion: cuts at FIM control tokens, drops text that merely repeats what already
 * follows the cursor, and trims trailing whitespace. Returns "" when nothing useful is left.
 */
export function cleanCompletion(raw: string, ctx: { suffix: string; stops: string[]; multiline: boolean }): string {
  let text = raw;
  for (const stop of ctx.stops) {
    const i = text.indexOf(stop);
    if (i >= 0) text = text.slice(0, i);
  }
  if (!ctx.multiline) text = text.split("\n")[0];
  // The model often re-emits the rest of the current line (e.g. a closing paren already there).
  const lineRest = ctx.suffix.split("\n")[0].trim();
  if (lineRest && text.trimEnd().endsWith(lineRest)) text = text.trimEnd().slice(0, -lineRest.length);
  // A completion equal to the start of the following text adds nothing.
  if (text.trim() && ctx.suffix.trimStart().startsWith(text.trim())) return "";
  return text.replace(/\s+$/, "");
}

/** Prefix/suffix windows around the cursor, cut at line boundaries where possible. */
export function contextWindow(text: string, offset: number, maxBefore: number, maxAfter: number): { prefix: string; suffix: string } {
  let start = Math.max(0, offset - maxBefore);
  if (start > 0) {
    const nl = text.indexOf("\n", start);
    if (nl >= 0 && nl < offset) start = nl + 1;
  }
  let end = Math.min(text.length, offset + maxAfter);
  if (end < text.length) {
    const nl = text.lastIndexOf("\n", end);
    if (nl > offset) end = nl;
  }
  return { prefix: text.slice(start, offset), suffix: text.slice(offset, end) };
}

/** Multi-line suggestions only where a new block is likely: at the end of a line that opens one, or on an empty line. */
export function wantsMultiline(prefix: string, suffix: string): boolean {
  const currentLine = prefix.slice(prefix.lastIndexOf("\n") + 1);
  const restOfLine = suffix.split("\n")[0];
  if (restOfLine.trim()) return false;
  return currentLine.trim() === "" || /[{(\[:]\s*$/.test(currentLine) || /=>\s*$/.test(currentLine);
}

export interface FimResult {
  text: string;
  latencyMs: number;
}

export async function requestFim(
  ep: FimEndpoint,
  prefix: string,
  suffix: string,
  opts: { multiline: boolean; signal?: AbortSignal; fetch?: typeof fetch; timeoutMs?: number },
): Promise<FimResult> {
  const req = buildFimRequest(ep, prefix, suffix, opts.multiline);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (ep.apiKey) headers.Authorization = `Bearer ${ep.apiKey}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onAbort);
  const t0 = Date.now();
  try {
    const res = await (opts.fetch ?? fetch)(req.url, { method: "POST", headers, body: JSON.stringify(req.body), signal: controller.signal });
    const body = (await res.json().catch(() => undefined)) as { choices?: { text?: string }[]; error?: { message?: string } } | undefined;
    if (!res.ok) throw new Error(`HTTP ${res.status}${body?.error?.message ? `: ${body.error.message}` : ""}`);
    const raw = body?.choices?.[0]?.text ?? "";
    return { text: cleanCompletion(raw, { suffix, stops: req.stops, multiline: opts.multiline }), latencyMs: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}
