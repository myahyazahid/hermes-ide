import { describe, expect, it } from "vitest";
import { effectiveAgentLanguage, languageNote, learningNote, parseAgentLanguage, parseLearningLevel } from "../../src/core/agentNotes";
import { validateCustomEndpoint } from "../../src/core/endpoint";
import { classifyUrl, isAcceptable } from "../../src/core/privacy";
import { ENDPOINT_PRESETS, isPresetUrl, PRESET_GROUPS } from "../../src/shared/presets";

describe("endpoint presets", () => {
  it("has unique ids and only known groups", () => {
    const ids = ENDPOINT_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of ENDPOINT_PRESETS) expect(PRESET_GROUPS).toContain(p.group);
    for (const g of PRESET_GROUPS) expect(ENDPOINT_PRESETS.some((p) => p.group === g)).toBe(true);
  });

  it("marks exactly the presets that leave the computer as remote, the way full local mode will judge them", () => {
    for (const p of ENDPOINT_PRESETS) {
      expect(isAcceptable(classifyUrl(p.baseUrl).kind), `${p.id} (${p.baseUrl})`).toBe(!p.remote);
      expect(p.group === "local", p.id).toBe(!p.remote);
      expect(p.needsKey, p.id).toBe(p.remote);
    }
  });

  it("gives every preset an address the Custom API form accepts, https for remote ones, and a note in both languages", () => {
    for (const p of ENDPOINT_PRESETS) {
      expect(validateCustomEndpoint({ baseUrl: p.baseUrl, model: "m", contextLength: 0 }), p.id).toBeUndefined();
      if (p.remote) expect(p.baseUrl.startsWith("https://"), p.id).toBe(true);
      expect(p.note.id.length, p.id).toBeGreaterThan(20);
      expect(p.note.en.length, p.id).toBeGreaterThan(20);
    }
  });

  it("never states a price: prices change, and the IDE does not guess them", () => {
    for (const p of ENDPOINT_PRESETS) {
      for (const text of [p.note.id, p.note.en]) {
        expect(text, p.id).not.toMatch(/\$\s?\d|\bUSD\s?\d|Rp\s?\d|\d\s?(USD|rupiah)\b/i);
      }
    }
  });

  it("links only over https, and lets the panel open nothing but those links", () => {
    for (const p of ENDPOINT_PRESETS) {
      for (const url of [p.helpUrl, p.pricingUrl]) {
        if (url) {
          expect(url.startsWith("https://"), url).toBe(true);
          expect(isPresetUrl(url)).toBe(true);
        }
      }
    }
    expect(isPresetUrl("https://evil.example.com/")).toBe(false);
    expect(isPresetUrl("file:///C:/Windows/System32/calc.exe")).toBe(false);
    expect(isPresetUrl("")).toBe(false);
  });
});

describe("agent notes", () => {
  it("reads the settings, defaulting to following the panel and to the beginner level", () => {
    expect(parseAgentLanguage(undefined)).toBe("ui");
    expect(parseAgentLanguage("nonsense")).toBe("ui");
    expect(parseAgentLanguage("off")).toBe("off");
    expect(parseLearningLevel(undefined)).toBe("beginner");
    expect(parseLearningLevel("intermediate")).toBe("intermediate");
  });

  it("answers in the panel's language unless told otherwise, and says nothing when switched off", () => {
    expect(effectiveAgentLanguage("ui", "id")).toBe("id");
    expect(effectiveAgentLanguage("ui", "en")).toBe("en");
    expect(effectiveAgentLanguage("en", "id")).toBe("en");
    expect(effectiveAgentLanguage("off", "id")).toBeUndefined();
  });

  it("asks for Indonesian in Indonesian and for English in English, and keeps code as it is", () => {
    expect(languageNote("id")).toMatch(/bahasa Indonesia/);
    expect(languageNote("id")).toMatch(/kode/i);
    expect(languageNote("en")).toMatch(/English/);
  });

  it("learning mode asks for the reason before each change, at the chosen depth, in the chosen language", () => {
    expect(learningNote("id", "beginner")).toMatch(/MENGAPA/);
    expect(learningNote("id", "beginner")).toMatch(/istilah/);
    expect(learningNote("id", "intermediate")).toMatch(/alternatif/);
    expect(learningNote("en", "beginner")).toMatch(/WHY/);
    expect(learningNote("en", "intermediate")).toMatch(/trade-off/);
    expect(learningNote("id", "beginner")).not.toBe(learningNote("id", "intermediate"));
  });
});
