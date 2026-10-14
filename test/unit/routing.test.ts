import { describe, expect, it } from "vitest";
import { resolveModelId } from "../../src/core/endpoint";
import {
  classifyPrompt, DEFAULT_LIGHT_MAX_CHARS, HEAVY_CONTEXT_CHARS, modelForTier, parseRoutingSettings, worthFallback, type RouteInput, type RoutingSettings,
} from "../../src/core/routing";

const settings = { lightMaxChars: 100 };
const route = (text: string, over: Partial<RouteInput> = {}) => classifyPrompt({ text, mode: "manual", context: [], ...over }, settings);

describe("classifyPrompt", () => {
  it("sends a short plain question to the light model", () => {
    expect(route("apa itu closure?")).toEqual({ tier: "light", reason: "routing.reason.short" });
    expect(route("rename variable x to count")).toEqual({ tier: "light", reason: "routing.reason.short" });
    expect(route("jelaskan fungsi ini")).toEqual({ tier: "light", reason: "routing.reason.short" });
  });

  it("uses the strong model for planning, whatever the length", () => {
    expect(route("hi", { mode: "plan" })).toEqual({ tier: "heavy", reason: "routing.reason.plan" });
  });

  it("uses the strong model when a lot of code is attached", () => {
    expect(route("ringkas", { context: [{ kind: "folder" }] }).reason).toBe("routing.reason.context");
    expect(route("cari", { context: [{ kind: "codebase" }] }).reason).toBe("routing.reason.context");
    expect(route("ringkas", { context: [{ kind: "file", chars: HEAVY_CONTEXT_CHARS + 1 }] }).reason).toBe("routing.reason.context");
    expect(route("ringkas", { context: [{ kind: "file", chars: 1500 }, { kind: "selection", chars: 2600 }] }).reason).toBe("routing.reason.context");
  });

  it("keeps a small attachment light", () => {
    expect(route("ringkas", { context: [{ kind: "selection", chars: 300 }] }).tier).toBe("light");
    expect(route("ringkas", { context: [{ kind: "file", chars: HEAVY_CONTEXT_CHARS }] }).tier).toBe("light");
  });

  it("treats images as heavy", () => {
    expect(route("apa ini?", { context: [{ kind: "image" }] }).reason).toBe("routing.reason.image");
  });

  it("is light up to the length limit and heavy past it", () => {
    expect(route("a".repeat(100)).tier).toBe("light");
    expect(route("a".repeat(101))).toEqual({ tier: "heavy", reason: "routing.reason.long" });
    expect(route("  " + "a".repeat(100) + "  ").tier).toBe("light"); // surrounding spaces do not count
  });

  it.each([
    "tolong refactor fungsi ini", "migrasi database ke postgres", "Migrate the auth module", "rancang arsitektur layanan", "debug kenapa tes gagal", "optimize the query",
    "implementasi fitur login", "tulis ulang modul pembayaran", "audit keamanan endpoint", "perbaiki race condition", "ubah di seluruh proyek", "update across the repo",
  ])("flags %s as heavy work", (text) => {
    expect(route(text)).toEqual({ tier: "heavy", reason: "routing.reason.keyword" });
  });

  it("matches whole words: a longer word that only contains a keyword does not count", () => {
    expect(route("siapa designer-nya?").tier).toBe("light");
    expect(route("what is the design of a button?").reason).toBe("routing.reason.keyword");
    expect(route("start the debugger").reason).toBe("routing.reason.keyword"); // debug\w* is meant to cover debugger and debugging
  });

  it("checks the rules in order: plan beats everything, context beats length", () => {
    expect(route("a".repeat(500), { mode: "plan" }).reason).toBe("routing.reason.plan");
    expect(route("a".repeat(500), { context: [{ kind: "folder" }] }).reason).toBe("routing.reason.context");
  });
});

describe("modelForTier", () => {
  const available = [
    { modelId: "custom:localhost:big-model", name: "big" },
    { modelId: "custom:localhost:small-model", name: "small" },
  ];
  const s: RoutingSettings = { enabled: true, lightModel: "small-model", heavyModel: "custom:localhost:big-model", fallbackModel: "", lightMaxChars: 280 };

  it("resolves names and exact ids, and returns undefined for unset or unknown models", () => {
    expect(modelForTier(s, "light", available, resolveModelId)).toBe("custom:localhost:small-model");
    expect(modelForTier(s, "heavy", available, resolveModelId)).toBe("custom:localhost:big-model");
    expect(modelForTier({ ...s, lightModel: "" }, "light", available, resolveModelId)).toBeUndefined();
    expect(modelForTier({ ...s, lightModel: "nope" }, "light", available, resolveModelId)).toBeUndefined();
  });
});

describe("worthFallback", () => {
  it("fails over for auth, credits, missing model, rate limit and server errors, not for bad requests", () => {
    for (const status of [401, 402, 403, 404, 408, 429, 500, 502, 503, 529]) expect(worthFallback(status)).toBe(true);
    for (const status of [400, 413, 422]) expect(worthFallback(status)).toBe(false);
  });
});

describe("parseRoutingSettings", () => {
  it("trims, defaults and clamps", () => {
    expect(parseRoutingSettings({})).toEqual({ enabled: false, lightModel: "", heavyModel: "", fallbackModel: "", lightMaxChars: DEFAULT_LIGHT_MAX_CHARS });
    expect(parseRoutingSettings({ enabled: true, lightModel: "  a ", heavyModel: 5, fallbackModel: "b", lightMaxChars: 5 })).toEqual({
      enabled: true, lightModel: "a", heavyModel: "", fallbackModel: "b", lightMaxChars: 20,
    });
    expect(parseRoutingSettings({ lightMaxChars: 99999 }).lightMaxChars).toBe(4000);
    expect(parseRoutingSettings({ enabled: "yes" }).enabled).toBe(false);
  });
});
