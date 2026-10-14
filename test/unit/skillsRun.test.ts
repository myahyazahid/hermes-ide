import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inspectSkill, installSkill, listInstalledSkills, searchSkills, uninstallSkill } from "../../src/core/skills";

// A stand-in for the hermes CLI: it records how it was called and answers like `hermes skills ...` does.
const FAKE = `
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_OUT, JSON.stringify({ args, home: process.env.HERMES_HOME }) + "\\n");
const [skills, sub, arg] = args;
if (skills !== "skills") process.exit(2);
if (sub === "search") console.log(JSON.stringify([{ name: "watchers", identifier: "official/devops/watchers", source: "official", trust_level: "builtin", description: "Poll." }]));
else if (sub === "list") console.log("┌──┐\\n│ Name │ Category │ Source │ Trust │ Status │\\n├──┤\\n│ pdf │ docs │ official │ builtin │ enabled │\\n└──┘");
else if (sub === "inspect") console.log("Skill " + arg + "\\nDoes things.");
else if (sub === "install") console.log(process.env.FAKE_FAIL ? "Decision: BLOCKED" : "Installed: devops/" + arg.split("/").pop());
else if (sub === "uninstall") console.log("Removed " + arg);
`;

describe("running hermes skills", () => {
  let dir: string;
  let hermes: string;
  let out: string;
  const calls = () => readFileSync(out, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { args: string[]; home: string });
  const ctx = (extra: NodeJS.ProcessEnv = {}) => ({ hermes, home: "C:\\fake home\\.hermes", env: { ...process.env, FAKE_OUT: out, ...extra } });

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "hermes-skills-"));
    out = path.join(dir, "calls.jsonl");
    writeFileSync(out, "");
    writeFileSync(path.join(dir, "fake.js"), FAKE);
    // A .cmd shim is how the IDE meets Hermes on some installs: it runs through a shell, the riskier path.
    hermes = path.join(dir, "hermes.cmd");
    writeFileSync(hermes, `@echo off\r\n"${process.execPath}" "${path.join(dir, "fake.js")}" %*\r\n`);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it.skipIf(process.platform !== "win32")("searches with the query as one argument, in the IDE's Hermes home", async () => {
    const result = await searchSkills(ctx(), "git merge", 5);
    expect(result.ok).toBe(true);
    expect(result.hits.map((h) => h.identifier)).toEqual(["official/devops/watchers"]);
    expect(calls().at(-1)).toEqual({ args: ["skills", "search", "git merge", "--limit", "5", "--json"], home: "C:\\fake home\\.hermes" });
  });

  it.skipIf(process.platform !== "win32")("lists, inspects, installs with --yes, and uninstalls", async () => {
    expect((await listInstalledSkills(ctx())).skills).toEqual([{ name: "pdf", category: "docs", source: "official", trust: "builtin", enabled: true }]);
    expect((await inspectSkill(ctx(), "official/devops/watchers")).text).toContain("Does things.");
    expect((await installSkill(ctx(), "official/devops/watchers")).ok).toBe(true);
    expect(calls().at(-1)!.args).toEqual(["skills", "install", "official/devops/watchers", "--yes"]);
    expect((await uninstallSkill(ctx(), "watchers")).ok).toBe(true);
    expect(calls().at(-1)!.args).toEqual(["skills", "uninstall", "watchers", "--yes"]);
  });

  it.skipIf(process.platform !== "win32")("never passes --force: a blocked verdict stays blocked", async () => {
    const result = await installSkill(ctx({ FAKE_FAIL: "1" }), "community/evil/skill");
    expect(result.ok).toBe(false);
    expect(calls().flatMap((c) => c.args)).not.toContain("--force");
  });

  it("refuses anything that is not a plain identifier, name or query, without running Hermes", async () => {
    const before = readFileSync(out, "utf8");
    expect((await searchSkills(ctx(), 'x"; calc')).ok).toBe(false);
    expect((await installSkill(ctx(), "a; calc")).ok).toBe(false);
    expect((await installSkill(ctx(), "https://example.com/SKILL.md")).ok).toBe(false);
    expect((await uninstallSkill(ctx(), "../escape")).ok).toBe(false);
    expect((await inspectSkill(ctx(), "$(calc)")).ok).toBe(false);
    expect(readFileSync(out, "utf8")).toBe(before);
  });
});
