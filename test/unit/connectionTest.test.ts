import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contextFromModelEntry, testConnection } from "../../src/core/connectionTest";
import { startOpenAIMock, type OpenAIMock } from "../fixtures/openai-mock.mjs";

describe("testConnection", () => {
  let mock: OpenAIMock;
  beforeEach(async () => {
    mock = await startOpenAIMock({ apiKey: "sk-good", models: [{ id: "big", context_length: 131072 }, { id: "tiny", context_length: 8192 }] });
  });
  afterEach(() => mock.close());

  it("reports latency, tool support and context for a healthy endpoint", async () => {
    mock.script([{ toolCalls: [{ name: "ping", arguments: { value: "hermes" } }] }]);
    const r = await testConnection({ baseUrl: mock.baseUrl + "/", model: "big", apiKey: "sk-good" });
    expect(r).toMatchObject({ ok: true, toolUse: "supported", contextLength: 131072 });
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    const chat = mock.chatRequests()[0];
    expect(chat.auth).toBe("Bearer sk-good");
    expect(chat.body.tools[0].function.name).toBe("ping");
  });

  it("flags a rejected key", async () => {
    const r = await testConnection({ baseUrl: mock.baseUrl, model: "big", apiKey: "sk-bad" });
    expect(r).toMatchObject({ ok: false, problem: "auth" });
    expect(r.detail).toContain("401");
  });

  it("flags an unknown model", async () => {
    const r = await testConnection({ baseUrl: mock.baseUrl, model: "ghost", apiKey: "sk-good" });
    expect(r).toMatchObject({ ok: false, problem: "model", modelNotListed: true });
  });

  it("flags a context window below 64k", async () => {
    mock.script([{ toolCalls: [{ name: "ping", arguments: { value: "hermes" } }] }]);
    const r = await testConnection({ baseUrl: mock.baseUrl, model: "tiny", apiKey: "sk-good" });
    expect(r).toMatchObject({ ok: false, problem: "context", contextLength: 8192 });
  });

  it("lets a manual context length override detection", async () => {
    mock.script([{ toolCalls: [{ name: "ping", arguments: { value: "hermes" } }] }]);
    const r = await testConnection({ baseUrl: mock.baseUrl, model: "tiny", apiKey: "sk-good", contextLength: 65536 });
    expect(r).toMatchObject({ ok: true, contextLength: 65536 });
  });

  it("detects endpoints that reject tool calling", async () => {
    mock.setDefault({ text: "OK", rejectTools: true });
    const r = await testConnection({ baseUrl: mock.baseUrl, model: "big", apiKey: "sk-good" });
    expect(r).toMatchObject({ ok: false, problem: "toolUse", toolUse: "unsupported" });
    expect(mock.chatRequests()).toHaveLength(2);
  });

  it("reports tool use as unknown when the model answers with text", async () => {
    const r = await testConnection({ baseUrl: mock.baseUrl, model: "big", apiKey: "sk-good" });
    expect(r).toMatchObject({ ok: true, toolUse: "unknown" });
  });

  it("reports network failures", async () => {
    const port = mock.port;
    await mock.close();
    const r = await testConnection({ baseUrl: `http://127.0.0.1:${port}/v1`, model: "big" }, { timeoutMs: 3000 });
    expect(r).toMatchObject({ ok: false, problem: "network" });
    mock = await startOpenAIMock(); // keep afterEach happy
  });

  it("reports a wrong path as a URL problem", async () => {
    const r = await testConnection({ baseUrl: `http://127.0.0.1:${mock.port}/nope`, model: "big", apiKey: "sk-good" });
    expect(r.ok).toBe(false);
    expect(r.problem === "url" || r.problem === "model").toBe(true);
  });
});

describe("contextFromModelEntry", () => {
  it("understands the common provider fields", () => {
    expect(contextFromModelEntry({ id: "a", context_length: 200000 })).toBe(200000);
    expect(contextFromModelEntry({ id: "a", max_model_len: 32768 })).toBe(32768);
    expect(contextFromModelEntry({ id: "a", top_provider: { context_length: 1000000 } })).toBe(1000000);
    expect(contextFromModelEntry({ id: "a", context_window: "65536" })).toBe(65536);
    expect(contextFromModelEntry({ id: "a" })).toBeUndefined();
  });
});
