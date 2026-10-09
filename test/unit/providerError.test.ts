import { describe, expect, it } from "vitest";
import { parseProviderError, providerErrorKind } from "../../src/core/providerError";

describe("parseProviderError", () => {
  it("reads Hermes' retry log line for an Anthropic credits error", () => {
    const line =
      "2026-10-09 23:19:40 [WARNING] agent.turn_recovery: Retrying API call in 4s (attempt 1/3) provider=anthropic policy=default " +
      "error=Error code: 429 - {'type': 'error', 'error': {'type': 'rate_limit_error', 'message': 'Usage credits are required for this model.', " +
      "'details': {'error_code': 'credits_required', 'model': 'claude-fable-5-1'}}, 'request_id': 'req_1'}";
    expect(parseProviderError(line)).toEqual({ status: 429, message: "Usage credits are required for this model.", model: "claude-fable-5-1", attempt: "1/3" });
    expect(providerErrorKind(429)).toBe("rateLimit");
  });

  it("handles JSON-style bodies and ignores unrelated lines", () => {
    expect(parseProviderError('error=Error code: 401 - {"error": {"message": "Invalid API key"}}')).toMatchObject({ status: 401, message: "Invalid API key" });
    expect(parseProviderError("Retrying API call in 4s (attempt 1/3)")).toBeUndefined();
    expect(providerErrorKind(503)).toBe("server");
    expect(providerErrorKind(403)).toBe("auth");
  });
});
