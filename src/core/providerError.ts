// Hermes retries failed model calls quietly and only tells the client "retrying API call after
// error". The reason (rate limit, missing credits, bad key, unknown model) is in its stderr log:
//   Retrying API call in 4s (attempt 1/3) ... error=Error code: 429 - {'type': 'error', 'error': {... 'message': '...'}}
// This pulls out what a user needs to act on.

export interface ProviderError {
  status: number;
  message: string;
  model?: string;
  attempt?: string;
}

export function parseProviderError(line: string): ProviderError | undefined {
  const code = /Error code: (\d{3})/.exec(line);
  if (!code) return undefined;
  const status = Number(code[1]);
  const message =
    /'message':\s*'((?:[^'\\]|\\.)*)'/.exec(line)?.[1] ??
    /"message":\s*"((?:[^"\\]|\\.)*)"/.exec(line)?.[1] ??
    line.slice(code.index + code[0].length).replace(/^\s*-\s*/, "").slice(0, 200);
  const model = /'model':\s*'([^']+)'/.exec(line)?.[1] ?? /"model":\s*"([^"]+)"/.exec(line)?.[1];
  const attempt = /attempt (\d+\/\d+)/.exec(line)?.[1];
  return { status, message: message.trim(), model, attempt };
}

/** Short, actionable hint for the common statuses. */
export function providerErrorKind(status: number): "auth" | "credits" | "rateLimit" | "notFound" | "server" | "other" {
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "credits";
  if (status === 429) return "rateLimit";
  if (status === 404) return "notFound";
  if (status >= 500) return "server";
  return "other";
}
