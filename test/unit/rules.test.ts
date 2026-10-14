import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assembleRules, loadProjectRules, MAX_RULES_BYTES, RULES_TEMPLATE, rulesNote, stripProjectRules } from "../../src/core/rules";

describe("assembleRules", () => {
  it("returns undefined for nothing or whitespace", () => {
    expect(assembleRules([])).toBeUndefined();
    expect(assembleRules([{ path: ".hermes/rules.md", text: "  \r\n\t \n" }])).toBeUndefined();
  });

  it("uses a single file as is and normalises BOM and CRLF", () => {
    const r = assembleRules([{ path: ".hermes/rules.md", text: "﻿Use tabs.\r\nNo semicolons.\r\n" }])!;
    expect(r.text).toBe("Use tabs.\nNo semicolons.");
    expect(r.files).toEqual([{ path: ".hermes/rules.md", bytes: 24 }]);
    expect(r.truncated).toBe(false);
  });

  it("labels each file when there are several, skipping empty ones", () => {
    const r = assembleRules([
      { path: ".hermes/rules.md", text: "General." },
      { path: ".hermes/rules/empty.md", text: "\n" },
      { path: ".hermes/rules/tests.md", text: "Run vitest." },
    ])!;
    expect(r.text).toBe("## .hermes/rules.md\n\nGeneral.\n\n## .hermes/rules/tests.md\n\nRun vitest.");
    expect(r.files.map((f) => f.path)).toEqual([".hermes/rules.md", ".hermes/rules/tests.md"]);
  });

  it("changes its hash only when the effective text changes", () => {
    const a = assembleRules([{ path: "a.md", text: "same" }])!;
    const b = assembleRules([{ path: "a.md", text: "same\r\n" }])!;
    const c = assembleRules([{ path: "a.md", text: "different" }])!;
    expect(a.hash).toBe(b.hash);
    expect(a.hash).not.toBe(c.hash);
  });

  it("caps the size on a byte budget without splitting a character", () => {
    const r = assembleRules([{ path: "a.md", text: "é".repeat(MAX_RULES_BYTES) }])!;
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.text, "utf8")).toBeLessThanOrEqual(MAX_RULES_BYTES + 30);
    expect(r.text).not.toContain("�");
    expect(r.text.endsWith("…[rules truncated]")).toBe(true);
  });
});

describe("loadProjectRules", () => {
  let root: string;
  beforeEach(() => void (root = mkdtempSync(path.join(tmpdir(), "hermes-rules-"))));
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("finds nothing in a project without rules", () => {
    expect(loadProjectRules(root)).toBeUndefined();
    expect(loadProjectRules("")).toBeUndefined();
  });

  it("reads .hermes/rules.md and the files in .hermes/rules/ in name order", () => {
    mkdirSync(path.join(root, ".hermes", "rules"), { recursive: true });
    writeFileSync(path.join(root, ".hermes", "rules.md"), "Main rule.");
    writeFileSync(path.join(root, ".hermes", "rules", "b-style.md"), "Style.");
    writeFileSync(path.join(root, ".hermes", "rules", "a-tests.md"), "Tests.");
    writeFileSync(path.join(root, ".hermes", "rules", "notes.json"), "{}");
    const r = loadProjectRules(root)!;
    expect(r.files.map((f) => f.path)).toEqual([".hermes/rules.md", ".hermes/rules/a-tests.md", ".hermes/rules/b-style.md"]);
    expect(r.text).toContain("## .hermes/rules/a-tests.md\n\nTests.");
    expect(r.text).not.toContain("{}");
  });

  it("ignores a rules path that is a directory", () => {
    mkdirSync(path.join(root, ".hermes", "rules.md"), { recursive: true });
    expect(loadProjectRules(root)).toBeUndefined();
  });
});

describe("rulesNote and stripProjectRules", () => {
  const rules = assembleRules([{ path: ".hermes/rules.md", text: "Always add tests." }])!;

  it("wraps the rules in tags naming their source", () => {
    const note = rulesNote(rules);
    expect(note.startsWith('<project-rules source=".hermes/rules.md">')).toBe(true);
    expect(note).toContain("Always add tests.");
    expect(note.endsWith("</project-rules>")).toBe(true);
  });

  it("removes the block from a replayed user message, leaving what the user typed", () => {
    const replayed = `${rulesNote(rules)}\n\nfix the login bug`;
    expect(stripProjectRules(replayed)).toBe("fix the login bug");
    expect(stripProjectRules("no rules here")).toBe("no rules here");
  });

  it("also hides a block that has not finished streaming", () => {
    expect(stripProjectRules("<project-rules source=\"x\">half a rule")).toBe("");
  });
});

describe("RULES_TEMPLATE", () => {
  it("exists in both UI languages", () => {
    expect(RULES_TEMPLATE.id).toContain("Aturan proyek");
    expect(RULES_TEMPLATE.en).toContain("Project rules");
  });
});
