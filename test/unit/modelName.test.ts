import { describe, expect, it } from "vitest";
import { prettyModelName, shortPath, splitPath } from "../../webview/src/format";

describe("prettyModelName", () => {
  it("turns model ids into readable names", () => {
    expect(prettyModelName("claude-opus-4-5-20251101")).toEqual({ name: "Claude Opus 4.5", date: "20251101" });
    expect(prettyModelName("claude-sonnet-5-5")).toEqual({ name: "Claude Sonnet 5.5", date: undefined });
    expect(prettyModelName("ag/gemini-3.8-flash-high").name).toBe("Gemini 3.8 Flash High");
    expect(prettyModelName("openrouter:gpt-4o-mini").name).toBe("GPT 4o Mini");
    expect(prettyModelName("customer-service").name).toBe("Customer Service");
    expect(prettyModelName("Custom endpoint · customer-service").name).toBe("Customer Service");
    expect(prettyModelName("claude-3-5-sonnet").name).toBe("Claude 3.5 Sonnet");
  });
});

describe("splitPath", () => {
  it("keeps workspace folders and shortens outside paths", () => {
    expect(splitPath("C:/repo/src/a.ts", "C:/repo")).toEqual({ name: "a.ts", dir: "src" });
    expect(splitPath("C:/repo/a.ts", "C:/repo")).toEqual({ name: "a.ts", dir: "" });
    expect(splitPath("C:/Users/- LENOVO -/AppData/Local/hermes/cache/scratch/portfolio.html", "C:/repo"))
      .toEqual({ name: "portfolio.html", dir: "…/cache/scratch" });
    expect(shortPath(String.raw`C:\tmp\x.txt`, "C:/repo")).toBe("C:/tmp/x.txt");
  });
});
