import { describe, expect, it } from "vitest";
import { classifyModelId, evaluatePrivacy, scanHermesConfig, type PrivacyInput } from "../../src/core/privacy";

describe("classifyModelId", () => {
  it.each([
    ["custom:localhost:qwen2.5-coder", "local"],
    ["custom:127.0.0.1:model", "local"],
    ["custom:192.168.1.9:model", "private"],
    ["custom:router.example.com:customer-service", "remote"],
    ["custom:mock-model", "local"], // no host in the id: the configured endpoint decides
    ["custom:llama3.1:8b", "local"], // a dotted model name is not a host
    ["custom:qwen2.5-coder:7b", "local"],
    ["custom:gpu-box.lan:model", "private"],
    ["ollama:qwen3:32b", "local"],
    ["anthropic:claude-opus-4-5", "remote"],
    ["openrouter:anthropic/claude-x", "remote"],
    ["some-new-provider:model", "unknown"],
    ["bare-model-name", "unknown"],
  ])("%s -> %s", (id, expected) => {
    expect(classifyModelId(id)).toBe(expected);
  });

  it("honours a named own server", () => {
    expect(classifyModelId("custom:vps.example.com:model", ["vps.example.com"])).toBe("allowed");
  });
});

describe("scanHermesConfig", () => {
  const config = `
model:
  default: local-model
  provider: custom
  base_url: http://localhost:8000/v1
custom_providers:
  - name: cloud
    base_url: https://api.example.com/v1
auxiliary:
  compression:
    provider: openrouter
    model: cheap
  vision:
    base_url: http://localhost:11434/v1
fallback_providers:
  - provider: anthropic
    model: claude-x
delegation:
  provider: auto
tts:
  provider: elevenlabs
`;

  it("finds the endpoints Hermes uses on its own and ignores the main model, custom_providers and unrelated blocks", () => {
    expect(scanHermesConfig(config)).toEqual([
      { path: "auxiliary.compression.provider", value: "openrouter" },
      { path: "auxiliary.vision.base_url", value: "http://localhost:11434/v1" },
      { path: "fallback_providers[0].provider", value: "anthropic" },
      { path: "delegation.provider", value: "auto" },
    ]);
  });

  it("copes with empty, broken and non-mapping files", () => {
    expect(scanHermesConfig("")).toEqual([]);
    expect(scanHermesConfig("just a string")).toEqual([]);
    expect(scanHermesConfig(":\n  - [")).toEqual([]);
  });
});

const base: PrivacyInput = {
  localOnly: true,
  allowedHosts: [],
  model: { kind: "hermes", baseUrl: "http://localhost:8000/v1", provider: "custom" },
  completion: { enabled: false, baseUrl: "" },
  index: { enabled: false, baseUrl: "" },
  mcpServers: [],
  guardActive: true,
};

describe("evaluatePrivacy: model switches and automatic endpoints", () => {
  it("blocks when the selected model has been switched to a remote provider", () => {
    const r = evaluatePrivacy({ ...base, currentModelId: "anthropic:claude-opus-4-5" });
    expect(r.blockers.map((b) => b.id)).toEqual(["model"]);
    expect(r.blockers[0].args).toEqual(["anthropic:claude-opus-4-5"]);
  });

  it("accepts a local selected model", () => {
    expect(evaluatePrivacy({ ...base, currentModelId: "custom:localhost:qwen" }).blockers).toEqual([]);
  });

  it("does not double-report when the configured endpoint is already blocked", () => {
    const r = evaluatePrivacy({ ...base, model: { kind: "hermes", baseUrl: "https://api.openai.com/v1" }, currentModelId: "openai:gpt-x" });
    expect(r.items.filter((i) => i.id === "model")).toHaveLength(1);
  });

  it("blocks when the user's config sends summaries or fallbacks to the internet", () => {
    const r = evaluatePrivacy({
      ...base,
      configEndpoints: [
        { path: "auxiliary.compression.provider", value: "openrouter" },
        { path: "auxiliary.vision.base_url", value: "http://localhost:11434/v1" },
      ],
    });
    expect(r.blockers.map((b) => b.id)).toEqual(["other"]);
    expect(r.blockers[0].args?.[0]).toContain("auxiliary.compression.provider = openrouter");
    expect(r.blockers[0].args?.[0]).not.toContain("11434");
  });

  it("accepts automatic endpoints that are local, 'auto' or 'custom'", () => {
    const r = evaluatePrivacy({
      ...base,
      configEndpoints: [
        { path: "delegation.provider", value: "auto" },
        { path: "auxiliary.x.provider", value: "ollama" },
        { path: "auxiliary.y.base_url", value: "http://192.168.1.4:8000" },
      ],
    });
    expect(r.blockers).toEqual([]);
  });

  it("only warns about all of this when the mode is off", () => {
    const r = evaluatePrivacy({ ...base, localOnly: false, currentModelId: "openai:gpt-x", configEndpoints: [{ path: "fallback_providers[0].provider", value: "anthropic" }] });
    expect(r.blockers).toEqual([]);
    expect(r.items.filter((i) => i.verdict === "warn").map((i) => i.id)).toEqual(expect.arrayContaining(["model", "other"]));
  });
});
