// OpenAI-compatible /v1/embeddings client for the codebase index (F-18).
import { normalizeBaseUrl } from "./endpoint";

export interface EmbeddingEndpoint {
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export const EMBED_BATCH = 32;

export async function embed(
  ep: EmbeddingEndpoint,
  inputs: string[],
  opts: { signal?: AbortSignal; fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<Float32Array[]> {
  const out: Float32Array[] = [];
  for (let i = 0; i < inputs.length; i += EMBED_BATCH) {
    out.push(...(await embedBatch(ep, inputs.slice(i, i + EMBED_BATCH), opts)));
  }
  return out;
}

async function embedBatch(
  ep: EmbeddingEndpoint,
  inputs: string[],
  opts: { signal?: AbortSignal; fetch?: typeof fetch; timeoutMs?: number },
): Promise<Float32Array[]> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (ep.apiKey) headers.Authorization = `Bearer ${ep.apiKey}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000);
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onAbort);
  try {
    const res = await (opts.fetch ?? fetch)(`${normalizeBaseUrl(ep.baseUrl)}/embeddings`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: ep.model, input: inputs }),
      signal: controller.signal,
    });
    const body = (await res.json().catch(() => undefined)) as
      | { data?: { index?: number; embedding?: number[] }[]; error?: { message?: string } }
      | undefined;
    if (!res.ok) throw new Error(`HTTP ${res.status}${body?.error?.message ? `: ${body.error.message}` : ""}`);
    const data = [...(body?.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    if (data.length !== inputs.length) throw new Error(`expected ${inputs.length} embeddings, got ${data.length}`);
    return data.map((d) => normalize(Float32Array.from(d.embedding ?? [])));
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

/** Unit length, so cosine similarity becomes a dot product. */
export function normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (const x of v) sum += x * x;
  const n = Math.sqrt(sum) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}
