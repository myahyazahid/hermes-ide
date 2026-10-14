// The models a custom OpenAI-compatible endpoint serves (GET {base}/models). An Ollama or vLLM server usually hosts
// several; Hermes lists only the one the profile names, but it accepts any of the others as "custom:<id>" when
// switching, so the IDE offers them for the model picker and for routing.
import { normalizeBaseUrl } from "./endpoint";

export const MAX_ENDPOINT_MODELS = 100;

type FetchFn = typeof fetch;

/** Model ids the endpoint lists, or [] when it has no /models route, rejects the request or does not answer in time. */
export async function listEndpointModels(
  endpoint: { baseUrl: string; apiKey?: string },
  opts: { fetch?: FetchFn; timeoutMs?: number } = {},
): Promise<string[]> {
  const doFetch = opts.fetch ?? fetch;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (endpoint.apiKey) headers.Authorization = `Bearer ${endpoint.apiKey}`;
  try {
    const res = await doFetch(`${normalizeBaseUrl(endpoint.baseUrl)}/models`, { headers, signal: AbortSignal.timeout(opts.timeoutMs ?? 3000) });
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: unknown };
    if (!Array.isArray(body?.data)) return [];
    const ids = body.data.map((m) => (m && typeof m === "object" ? (m as { id?: unknown }).id : undefined));
    return [...new Set(ids.filter((id): id is string => typeof id === "string" && id.trim().length > 0))].slice(0, MAX_ENDPOINT_MODELS);
  } catch {
    return [];
  }
}
