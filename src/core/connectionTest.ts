// "Tes koneksi" for a custom OpenAI-compatible endpoint (F-04). It sends one tiny request with a
// dummy tool so it can report latency and whether tool calling works, and maps failures to the
// causes the PRD lists: wrong URL, rejected key, unknown model, context below 64k.
import { MIN_CONTEXT_TOKENS, normalizeBaseUrl, type CustomEndpoint } from "./endpoint";

export type ConnectionProblem = "url" | "auth" | "model" | "context" | "network" | "toolUse" | "other";
export type ToolUseStatus = "supported" | "unsupported" | "unknown";

export interface ConnectionTestResult {
  ok: boolean;
  problem?: ConnectionProblem;
  /** Server-provided detail (status code, error message); shown below the translated cause. */
  detail?: string;
  latencyMs?: number;
  toolUse: ToolUseStatus;
  contextLength?: number;
  /** True when /models answered but did not list the configured model. */
  modelNotListed?: boolean;
}

type FetchFn = typeof fetch;

const PING_TOOL = {
  type: "function",
  function: {
    name: "ping",
    description: "Connectivity check. Call it with the value the user gives.",
    parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
  },
};

export async function testConnection(
  ep: CustomEndpoint,
  opts: { fetch?: FetchFn; timeoutMs?: number; minContext?: number } = {},
): Promise<ConnectionTestResult> {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const minContext = opts.minContext ?? MIN_CONTEXT_TOKENS;
  const base = normalizeBaseUrl(ep.baseUrl);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (ep.apiKey) headers.Authorization = `Bearer ${ep.apiKey}`;

  // 1) /models: cheap, tells us auth problems and (often) the context window.
  let detectedContext: number | undefined;
  let modelNotListed = false;
  const models = await request(doFetch, `${base}/models`, { method: "GET", headers }, timeoutMs);
  if (models.kind === "network") return fail("network", models.detail);
  if (models.status === 401 || models.status === 403) return fail("auth", describe(models));
  if (models.status >= 200 && models.status < 300) {
    const list = Array.isArray(models.body?.data) ? (models.body.data as Record<string, unknown>[]) : undefined;
    if (list) {
      const entry = list.find((m) => m.id === ep.model);
      modelNotListed = !entry && list.length > 0;
      detectedContext = entry ? contextFromModelEntry(entry) : undefined;
    }
  } else if (models.status !== 404 && models.status !== 405) {
    // Some servers do not implement /models; anything else odd is still worth surfacing later.
    if (models.status >= 500) return fail("url", describe(models));
  }

  // 2) One chat completion with a tool attached.
  const body = {
    model: ep.model,
    messages: [{ role: "user", content: 'Call the ping tool with value "hermes". Do not answer with text.' }],
    tools: [PING_TOOL],
    tool_choice: "auto",
    max_tokens: 256,
    stream: false,
  };
  const t0 = Date.now();
  let chat = await request(doFetch, `${base}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body) }, timeoutMs);
  let latencyMs = Date.now() - t0;
  if (chat.kind === "network") return fail("network", chat.detail);
  if (chat.status === 401 || chat.status === 403) return fail("auth", describe(chat));

  let toolUse: ToolUseStatus = "unknown";
  if (chat.status === 400 && /tool|function/i.test(errorMessage(chat.body) ?? "")) {
    // Endpoint rejects tools outright. Retry without them to tell "reachable" from "broken".
    toolUse = "unsupported";
    const { tools: _t, tool_choice: _c, ...plain } = body;
    const t1 = Date.now();
    chat = await request(doFetch, `${base}/chat/completions`, { method: "POST", headers, body: JSON.stringify(plain) }, timeoutMs);
    latencyMs = Date.now() - t1;
    if (chat.kind === "network") return fail("network", chat.detail);
  }

  if (chat.status === 404) {
    const msg = errorMessage(chat.body) ?? "";
    return fail(/model/i.test(msg) ? "model" : "url", describe(chat));
  }
  if ((chat.status === 400 || chat.status === 422) && /model/i.test(errorMessage(chat.body) ?? "")) {
    return fail("model", describe(chat));
  }
  if (chat.status < 200 || chat.status >= 300) return fail("other", describe(chat));

  const message = chat.body?.choices?.[0]?.message;
  if (message === undefined) return fail("url", "Response is not an OpenAI-compatible chat completion");
  if (toolUse !== "unsupported") {
    toolUse = Array.isArray(message.tool_calls) && message.tool_calls.length > 0 ? "supported" : "unknown";
  }

  const contextLength = ep.contextLength && ep.contextLength > 0 ? ep.contextLength : detectedContext;
  const measured = { latencyMs, toolUse, contextLength, modelNotListed };
  if (contextLength !== undefined && contextLength < minContext) {
    return { ok: false, problem: "context", detail: `${contextLength} < ${minContext}`, ...measured };
  }
  if (toolUse === "unsupported") return { ok: false, problem: "toolUse", ...measured };
  return { ok: true, ...measured };

  function fail(problem: ConnectionProblem, detail?: string): ConnectionTestResult {
    return { ok: false, problem, detail, toolUse: "unknown", modelNotListed };
  }
}

/** Context window fields used by OpenRouter, vLLM, LM Studio and friends. */
export function contextFromModelEntry(entry: Record<string, unknown>): number | undefined {
  const top = entry.top_provider as Record<string, unknown> | undefined;
  const candidates = [
    entry.context_length, entry.context_window, entry.max_context_length, entry.max_model_len,
    entry.max_input_tokens, top?.context_length,
  ];
  for (const c of candidates) {
    const n = typeof c === "string" ? parseInt(c, 10) : c;
    if (typeof n === "number" && Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

type Reply =
  | { kind: "http"; status: number; body: any; text: string }
  | { kind: "network"; detail: string };

async function request(doFetch: FetchFn, url: string, init: RequestInit, timeoutMs: number): Promise<Reply> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    return { kind: "http", status: res.status, body, text };
  } catch (error) {
    const e = error as Error & { cause?: { code?: string; message?: string } };
    const detail = e.name === "AbortError" ? `timeout after ${timeoutMs} ms` : (e.cause?.code ?? e.cause?.message ?? e.message);
    return { kind: "network", detail };
  } finally {
    clearTimeout(timer);
  }
}

function errorMessage(body: any): string | undefined {
  const err = body?.error;
  if (typeof err === "string") return err;
  if (typeof err?.message === "string") return err.message;
  if (typeof body?.message === "string") return body.message;
  if (typeof body?.detail === "string") return body.detail;
  return undefined;
}

function describe(reply: Reply): string {
  if (reply.kind === "network") return reply.detail;
  const msg = errorMessage(reply.body) ?? reply.text.slice(0, 200);
  return `HTTP ${reply.status}${msg ? `: ${msg}` : ""}`;
}
