import { describe, expect, it } from "vitest";
import { listEndpointModels, MAX_ENDPOINT_MODELS } from "../../src/core/endpointModels";

const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

describe("listEndpointModels", () => {
  it("returns the ids the endpoint lists, once each", async () => {
    const ids = await listEndpointModels(
      { baseUrl: "http://localhost:11434/v1" },
      { fetch: reply(200, { data: [{ id: "qwen2.5-coder:7b" }, { id: "qwen3:32b" }, { id: "qwen3:32b" }, { id: "" }, { nope: 1 }, null] }) },
    );
    expect(ids).toEqual(["qwen2.5-coder:7b", "qwen3:32b"]);
  });

  it("asks {base}/models, with the key as a bearer token only when there is one", async () => {
    const seen: { url: string; auth?: string }[] = [];
    const spy = (async (url: string, init: RequestInit) => {
      seen.push({ url, auth: (init.headers as Record<string, string>).Authorization });
      return new Response(JSON.stringify({ data: [] }));
    }) as unknown as typeof fetch;
    await listEndpointModels({ baseUrl: "http://localhost:8000/v1/", apiKey: "k" }, { fetch: spy });
    await listEndpointModels({ baseUrl: "http://localhost:8000/v1" }, { fetch: spy });
    expect(seen).toEqual([
      { url: "http://localhost:8000/v1/models", auth: "Bearer k" },
      { url: "http://localhost:8000/v1/models", auth: undefined },
    ]);
  });

  it("gives an empty list for an error status, a missing route, a bad body or a dead server", async () => {
    expect(await listEndpointModels({ baseUrl: "http://x/v1" }, { fetch: reply(401, { error: "no" }) })).toEqual([]);
    expect(await listEndpointModels({ baseUrl: "http://x/v1" }, { fetch: reply(404, {}) })).toEqual([]);
    expect(await listEndpointModels({ baseUrl: "http://x/v1" }, { fetch: reply(200, { data: "nope" }) })).toEqual([]);
    const dead = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    expect(await listEndpointModels({ baseUrl: "http://x/v1" }, { fetch: dead })).toEqual([]);
  });

  it("caps a huge listing", async () => {
    const data = Array.from({ length: MAX_ENDPOINT_MODELS + 50 }, (_, i) => ({ id: `m${i}` }));
    expect(await listEndpointModels({ baseUrl: "http://x/v1" }, { fetch: reply(200, { data }) })).toHaveLength(MAX_ENDPOINT_MODELS);
  });
});
