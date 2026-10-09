import { describe, expect, it } from "vitest";
import { applyHunks, computeHunks, diffStat, sameText } from "../../src/core/hunks";

const OLD = ["a", "b", "c", "d", "e", "f", "g"].join("\n") + "\n";
const NEW = ["a", "B", "c", "d", "e", "f2", "f3", "g", "h"].join("\n") + "\n";

describe("computeHunks", () => {
  it("splits changes into separate hunks with line positions", () => {
    const { hunks } = computeHunks(OLD, NEW);
    expect(hunks).toEqual([
      { index: 0, oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 },
      { index: 1, oldStart: 5, oldLines: 1, newStart: 5, newLines: 2 },
      { index: 2, oldStart: 7, oldLines: 0, newStart: 8, newLines: 1 },
    ]);
  });

  it("round-trips: all hunks = new text, none = old text", () => {
    const d = computeHunks(OLD, NEW);
    expect(applyHunks(d, new Set([0, 1, 2]))).toBe(NEW);
    expect(applyHunks(d, new Set())).toBe(OLD);
  });

  it("keeps only the accepted hunks", () => {
    const d = computeHunks(OLD, NEW);
    expect(applyHunks(d, new Set([1]))).toBe(["a", "b", "c", "d", "e", "f2", "f3", "g"].join("\n") + "\n");
    expect(applyHunks(d, new Set([0, 2]))).toBe(["a", "B", "c", "d", "e", "f", "g", "h"].join("\n") + "\n");
  });

  it("handles new files and CRLF content", () => {
    const created = computeHunks("", "x\r\ny\r\n");
    expect(created.hunks).toHaveLength(1);
    expect(applyHunks(created, new Set([0]))).toBe("x\r\ny\r\n");
    const crlf = computeHunks("a\r\nb\r\n", "a\r\nB\r\n");
    expect(applyHunks(crlf, new Set())).toBe("a\r\nb\r\n");
  });

  it("returns no hunks for identical text", () => {
    expect(computeHunks(OLD, OLD).hunks).toEqual([]);
  });
});

describe("diffStat / sameText", () => {
  it("counts added and removed lines", () => {
    expect(diffStat(OLD, NEW)).toEqual({ added: 4, removed: 2 });
    expect(diffStat("", "one\ntwo\n")).toEqual({ added: 2, removed: 0 });
  });

  it("ignores line-ending differences", () => {
    expect(sameText("a\r\nb\r\n", "a\nb\n")).toBe(true);
    expect(sameText("a\nb", "a\nc")).toBe(false);
  });
});
