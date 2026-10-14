import { describe, expect, it } from "vitest";
import { supportsSecondarySidebar } from "../../src/core/sidebar";

describe("supportsSecondarySidebar", () => {
  it("is false before 1.106", () => {
    expect(supportsSecondarySidebar("1.95.0")).toBe(false);
    expect(supportsSecondarySidebar("1.105.9")).toBe(false);
  });

  it("is true from 1.106 on, including newer majors", () => {
    expect(supportsSecondarySidebar("1.106.0")).toBe(true);
    expect(supportsSecondarySidebar("1.135.06055")).toBe(true);
    expect(supportsSecondarySidebar("2.0.0")).toBe(true);
  });

  it("falls back to the activity bar when the version is unreadable", () => {
    expect(supportsSecondarySidebar("")).toBe(false);
    expect(supportsSecondarySidebar("next")).toBe(false);
  });
});
