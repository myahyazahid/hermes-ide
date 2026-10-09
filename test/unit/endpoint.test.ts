import { describe, expect, it } from "vitest";
import {
  buildLaunchEnv, buildProfileConfigYaml, defaultHermesHome, maskKey, readHermesModelConfig, resolveModelId,
  shortModelName, validateCustomEndpoint,
} from "../../src/core/endpoint";

describe("readHermesModelConfig", () => {
  it("reads the model section of a real-looking config with comments", () => {
    const yaml = [
      "# Hermes Agent CLI Configuration",
      "database:",
      '  journal_mode: "wal"',
      "model:",
      "  # Default model to use",
      '  default: "pateway"',
      "  #   \"custom\"  - Any other OpenAI-compatible endpoint.",
      '  provider: "custom"',
      "  # api_key: \"your-key-here\"",
      '  base_url: "https://router.example.com/v1"',
      "",
      "custom_providers:",
      "  - name: Router",
      "    model: other",
    ].join("\r\n");
    expect(readHermesModelConfig(yaml)).toEqual({ model: "pateway", provider: "custom", baseUrl: "https://router.example.com/v1" });
  });

  it("accepts `model:` as a plain string and unquoted values with trailing comments", () => {
    expect(readHermesModelConfig("model: gpt-x\n")).toEqual({ model: "gpt-x" });
    expect(readHermesModelConfig("model:\n  model: qwen3:32b  # local\n  provider: ollama\n")).toEqual({ model: "qwen3:32b", provider: "ollama" });
  });
});

describe("buildProfileConfigYaml", () => {
  it("writes base URL and model but never the key", () => {
    const yaml = buildProfileConfigYaml({ baseUrl: "https://x.test/v1/", model: 'm"1', apiKey: "sk-secret", contextLength: 128000 });
    expect(yaml).toContain('base_url: "https://x.test/v1"');
    expect(yaml).toContain('default: "m\\"1"');
    expect(yaml).toContain("context_length: 128000");
    expect(yaml).not.toContain("sk-secret");
  });
});

describe("buildLaunchEnv", () => {
  const parent = { PATH: "/bin", OPENAI_API_KEY: "parent-key", ANTHROPIC_API_KEY: "a", GITHUB_TOKEN: "gh" };

  it("leaves the environment alone in hermes mode", () => {
    const env = buildLaunchEnv({ parentEnv: parent, mode: "hermes" });
    expect(env.OPENAI_API_KEY).toBe("parent-key");
    expect(env.HERMES_HOME).toBeUndefined();
  });

  it("passes only the active key, paired with the base URL, in custom mode", () => {
    const env = buildLaunchEnv({
      parentEnv: parent, mode: "custom", profileHome: "/p",
      custom: { baseUrl: "https://x.test/v1/", model: "m", apiKey: "sk-active" },
    });
    expect(env.HERMES_HOME).toBe("/p");
    expect(env.OPENAI_API_KEY).toBe("sk-active");
    expect(env.OPENAI_BASE_URL).toBe("https://x.test/v1");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBe("gh");
  });

  it("drops inherited provider keys when the custom endpoint has no key", () => {
    const env = buildLaunchEnv({ parentEnv: parent, mode: "custom", custom: { baseUrl: "http://localhost:11434/v1", model: "m" } });
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.OPENAI_BASE_URL).toBeUndefined();
  });
});

describe("validateCustomEndpoint", () => {
  it("requires an http(s) URL and a model", () => {
    expect(validateCustomEndpoint({ baseUrl: "ftp://x", model: "m" })).toBe("invalidUrl");
    expect(validateCustomEndpoint({ baseUrl: "not a url", model: "m" })).toBe("invalidUrl");
    expect(validateCustomEndpoint({ baseUrl: "http://localhost:8000/v1", model: " " })).toBe("missingModel");
    expect(validateCustomEndpoint({ baseUrl: "http://localhost:8000/v1", model: "m" })).toBeUndefined();
  });
});

describe("model ids", () => {
  const available = [
    { modelId: "custom:pateway", name: "pateway" },
    { modelId: "custom:router.example.com:customer-service", name: "Router.example.com · customer-service" },
    { modelId: "anthropic:customer-service", name: "Anthropic · customer-service" },
  ];

  it("resolves a bare model name, preferring custom endpoints", () => {
    expect(resolveModelId(available, "customer-service")).toBe("custom:router.example.com:customer-service");
    expect(resolveModelId(available, "anthropic:customer-service")).toBe("anthropic:customer-service");
    expect(resolveModelId(available, "nope")).toBeUndefined();
  });

  it("shortens ids for display", () => {
    expect(shortModelName("custom:router.example.com:customer-service", available)).toBe("customer-service");
    expect(shortModelName("custom:localhost.lan:qwen3:32b")).toBe("qwen3:32b");
    expect(shortModelName("custom:pateway")).toBe("pateway");
    expect(shortModelName("anthropic:claude-x")).toBe("claude-x");
  });
});

describe("misc", () => {
  it("masks keys", () => {
    expect(maskKey("sk-1234567890abcdef")).toBe("sk-••••••••cdef");
    expect(maskKey("short")).toBe("•••••");
    expect(maskKey(undefined)).toBe("");
  });

  it("finds the Hermes home per platform", () => {
    expect(defaultHermesHome({ LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, "win32")).toBe("C:\\Users\\u\\AppData\\Local\\hermes");
    expect(defaultHermesHome({ HOME: "/home/u" }, "linux")).toBe("/home/u/.hermes");
    expect(defaultHermesHome({ HERMES_HOME: "/x", HOME: "/home/u" }, "linux")).toBe("/x");
  });
});
