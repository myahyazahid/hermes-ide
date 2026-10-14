import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_LIMITS, ENTRY_DELIMITER, loadMemory, memoryConfig, memoryPath, normalizeEntries, parseEntries, saveMemory, serializeEntries, usedChars,
} from "../../src/core/memory";

describe("memory entries", () => {
  it("parses the way Hermes does: full delimiter, stripped, no empty entries, BOM ignored", () => {
    expect(parseEntries("﻿one\n§\n  two  \n§\n\n§\nthree")).toEqual(["one", "two", "three"]);
    expect(parseEntries("")).toEqual([]);
  });

  it("keeps a bare § inside an entry", () => {
    expect(parseEntries("price § 5\n§\nnext")).toEqual(["price § 5", "next"]);
  });

  it("writes exactly what Hermes reads back: stripped entries joined by the delimiter, no trailing newline", () => {
    const text = serializeEntries([" a ", "", "b\n§\nc"]);
    expect(text).toBe(`a${ENTRY_DELIMITER}b${ENTRY_DELIMITER}c`);
    expect(parseEntries(text)).toEqual(["a", "b", "c"]);
  });

  it("counts characters of the joined text, the number Hermes checks against the limit", () => {
    expect(usedChars(["ab", "cd"])).toBe(2 + ENTRY_DELIMITER.length + 2);
    expect(normalizeEntries(["  x ", " "])).toEqual(["x"]);
  });
});

describe("memoryConfig", () => {
  it("uses Hermes' defaults without a config", () => {
    expect(memoryConfig(undefined)).toEqual({ limits: DEFAULT_LIMITS, enabled: { memory: true, user: true } });
    expect(memoryConfig("model:\n  default: x\n").limits).toEqual(DEFAULT_LIMITS);
    expect(memoryConfig(":\n  - [").limits).toEqual(DEFAULT_LIMITS);
  });

  it("reads limits and switches from the memory section", () => {
    const cfg = memoryConfig("memory:\n  memory_char_limit: 5000\n  user_char_limit: 100\n  memory_enabled: false\n  user_profile_enabled: 'off'\n");
    expect(cfg.limits).toEqual({ memory: 5000, user: 100 });
    expect(cfg.enabled).toEqual({ memory: false, user: false });
  });

  it("ignores nonsense limits", () => {
    expect(memoryConfig("memory:\n  memory_char_limit: -3\n  user_char_limit: lots\n").limits).toEqual(DEFAULT_LIMITS);
  });
});

describe("memory files", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "hermes-memory-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const write = (name: "MEMORY.md" | "USER.md", text: string) => {
    mkdirSync(path.join(home, "memories"), { recursive: true });
    writeFileSync(path.join(home, "memories", name), text, "utf8");
  };

  it("loads both files, empty when they do not exist yet", () => {
    const view = loadMemory(home, undefined);
    expect(view.targets.map((t) => [t.target, t.entries, t.limit, t.used])).toEqual([
      ["memory", [], 2200, 0],
      ["user", [], 1375, 0],
    ]);
    expect(view.targets[0].path).toBe(memoryPath(home, "memory"));
  });

  it("flags a file that is not a clean list, because saving will rewrite it", () => {
    write("MEMORY.md", "a\n§\nb\n");
    expect(loadMemory(home, undefined).targets[0].irregular).toBe(false); // a trailing newline is stripped by Hermes too
    write("MEMORY.md", "free text\n§\n\n§\nb");
    expect(loadMemory(home, undefined).targets[0].irregular).toBe(true);
  });

  it("saves, keeps the previous file as a backup, and the result reads back identically", () => {
    write("MEMORY.md", "old one\n§\nold two");
    const before = loadMemory(home, undefined).targets[0];
    const result = saveMemory(home, undefined, "memory", ["new one", "", " new two "], before.hash);
    expect(result.ok).toBe(true);
    expect(readFileSync(memoryPath(home, "memory"), "utf8")).toBe(`new one${ENTRY_DELIMITER}new two`);
    expect(readFileSync(memoryPath(home, "memory") + ".hermes-ide-bak", "utf8")).toBe("old one\n§\nold two");
    expect(loadMemory(home, undefined).targets[0].entries).toEqual(["new one", "new two"]);
  });

  it("creates the file and its folder when there was none, without a backup", () => {
    const before = loadMemory(home, undefined).targets[1];
    const result = saveMemory(home, undefined, "user", ["Saya pakai Windows."], before.hash);
    expect(result.ok).toBe(true);
    expect(readFileSync(memoryPath(home, "user"), "utf8")).toBe("Saya pakai Windows.");
    expect(existsSync(memoryPath(home, "user") + ".hermes-ide-bak")).toBe(false);
  });

  it("refuses to overwrite a file that changed since it was read (the agent saved something meanwhile)", () => {
    write("MEMORY.md", "first");
    const before = loadMemory(home, undefined).targets[0];
    write("MEMORY.md", "first\n§\nadded by the agent");
    const result = saveMemory(home, undefined, "memory", ["my edit"], before.hash);
    expect(result).toMatchObject({ ok: false, reason: "changed" });
    expect(readFileSync(memoryPath(home, "memory"), "utf8")).toBe("first\n§\nadded by the agent");
    if (!result.ok) expect(result.view.entries).toEqual(["first", "added by the agent"]);
  });

  it("refuses text that does not fit Hermes' budget, and an entry longer than it", () => {
    const before = loadMemory(home, "memory:\n  user_char_limit: 30\n").targets[1];
    expect(saveMemory(home, "memory:\n  user_char_limit: 30\n", "user", ["x".repeat(31)], before.hash)).toMatchObject({ ok: false, reason: "entryTooLong" });
    expect(saveMemory(home, "memory:\n  user_char_limit: 30\n", "user", ["x".repeat(20), "y".repeat(20)], before.hash)).toMatchObject({ ok: false, reason: "tooLong" });
    expect(existsSync(memoryPath(home, "user"))).toBe(false);
    expect(saveMemory(home, "memory:\n  user_char_limit: 30\n", "user", ["x".repeat(30)], before.hash).ok).toBe(true);
  });

  it("can empty a file", () => {
    write("USER.md", "something");
    const before = loadMemory(home, undefined).targets[1];
    expect(saveMemory(home, undefined, "user", [], before.hash).ok).toBe(true);
    expect(readFileSync(memoryPath(home, "user"), "utf8")).toBe("");
  });
});
