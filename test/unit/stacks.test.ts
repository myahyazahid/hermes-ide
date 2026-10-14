import { describe, expect, it } from "vitest";
import { assembleRules, MAX_RULES_BYTES } from "../../src/core/rules";
import { detectStacks, stackRules, stackRulesPath, type ProjectProbe } from "../../src/core/stackRules";
import { isStackId, STACKS, stackInfo } from "../../src/shared/stacks";

const probe = (files: Record<string, string>): ProjectProbe => ({ has: (p) => p in files, read: (p) => files[p] });

describe("detectStacks", () => {
  it("recognises Laravel from composer.json, or from artisan next to it", () => {
    expect(detectStacks(probe({ "composer.json": JSON.stringify({ require: { "laravel/framework": "^11.0" } }) }))).toEqual(["laravel"]);
    expect(detectStacks(probe({ "composer.json": "{}", artisan: "#!/usr/bin/env php" }))).toEqual(["laravel"]);
    expect(detectStacks(probe({ "composer.json": JSON.stringify({ require: { "symfony/console": "^7" } }) }))).toEqual([]);
  });

  it("reports Filament together with Laravel, also when it is only a dev dependency", () => {
    const composer = JSON.stringify({ require: { "laravel/framework": "^11.0", "filament/filament": "^3.2" } });
    expect(detectStacks(probe({ "composer.json": composer }))).toEqual(["laravel", "filament"]);
    expect(detectStacks(probe({ "composer.json": JSON.stringify({ "require-dev": { "filament/filament": "*" } }) }))).toEqual(["filament"]);
  });

  it("recognises Flutter by its SDK dependency, not by the word", () => {
    expect(detectStacks(probe({ "pubspec.yaml": "name: app\ndependencies:\n  flutter:\n    sdk: flutter\n  http: ^1.2.0\n" }))).toEqual(["flutter"]);
    expect(detectStacks(probe({ "pubspec.yaml": "name: flutter_helpers\ndependencies:\n  http: ^1.2.0\n" }))).toEqual([]);
  });

  it("recognises Next.js by its dependency, in either section", () => {
    expect(detectStacks(probe({ "package.json": JSON.stringify({ dependencies: { next: "15.0.0", react: "19" } }) }))).toEqual(["nextjs"]);
    expect(detectStacks(probe({ "package.json": JSON.stringify({ devDependencies: { next: "14" } }) }))).toEqual(["nextjs"]);
    expect(detectStacks(probe({ "package.json": JSON.stringify({ dependencies: { "next-auth": "4", react: "19" } }) }))).toEqual([]);
  });

  it("copes with a byte order mark, broken JSON and an empty project", () => {
    expect(detectStacks(probe({ "package.json": "﻿" + JSON.stringify({ dependencies: { next: "15" } }) }))).toEqual(["nextjs"]);
    expect(detectStacks(probe({ "package.json": "{ not json", "composer.json": "" }))).toEqual([]);
    expect(detectStacks(probe({}))).toEqual([]);
  });

  it("finds several stacks in one repository", () => {
    const files = {
      "composer.json": JSON.stringify({ require: { "laravel/framework": "^11" } }),
      "package.json": JSON.stringify({ devDependencies: { next: "15" } }),
    };
    expect(detectStacks(probe(files))).toEqual(["laravel", "nextjs"]);
  });
});

describe("rules packs", () => {
  it("exist for every stack in both languages, are short, and tell the agent to check the version first", () => {
    for (const s of STACKS) {
      for (const locale of ["id", "en"] as const) {
        const text = stackRules(s.id, locale);
        expect(text.startsWith("# "), `${s.id}/${locale}`).toBe(true);
        expect(Buffer.byteLength(text, "utf8"), `${s.id}/${locale}`).toBeLessThan(4000);
      }
    }
    expect(stackRules("laravel", "id")).toMatch(/composer\.json/);
    expect(stackRules("filament", "en")).toMatch(/version/i);
    expect(stackRules("nextjs", "en")).toMatch(/App Router/);
    expect(stackRules("flutter", "id")).toMatch(/flutter analyze/);
  });

  it("keep the two languages in step: the same number of rules", () => {
    for (const s of STACKS) {
      const count = (text: string) => text.split("\n").filter((l) => l.startsWith("- ")).length;
      expect(count(stackRules(s.id, "id")), s.id).toBe(count(stackRules(s.id, "en")));
    }
  });

  it("all fit in the budget the agent receives rules in, even together", () => {
    const all = STACKS.map((s) => ({ path: stackRulesPath(s.id), text: stackRules(s.id, "id") }));
    const assembled = assembleRules(all)!;
    expect(assembled.truncated).toBe(false);
    expect(Buffer.byteLength(assembled.text, "utf8")).toBeLessThan(MAX_RULES_BYTES);
  });

  it("are written to the folder the rules loader reads", () => {
    expect(stackRulesPath("laravel")).toBe(".hermes/rules/laravel.md");
  });

  it("never tell the agent to run something destructive on its own", () => {
    for (const s of STACKS) {
      for (const locale of ["id", "en"] as const) {
        const text = stackRules(s.id, locale);
        // destructive commands may be named, but only to forbid them
        for (const bad of ["migrate:fresh", "db:wipe"]) {
          if (text.includes(bad)) expect(text, `${s.id}/${locale}`).toMatch(/Jangan menjalankan|Never run/);
        }
      }
    }
  });
});

describe("stack table", () => {
  it("has starter prompts and a new-project prompt in both languages, and unique ids", () => {
    expect(new Set(STACKS.map((s) => s.id)).size).toBe(STACKS.length);
    for (const s of STACKS) {
      expect(s.starters.id.length, s.id).toBeGreaterThanOrEqual(2);
      expect(s.starters.en.length, s.id).toBe(s.starters.id.length);
      expect(s.newProject.id.length).toBeGreaterThan(30);
      expect(s.newProject.en.length).toBeGreaterThan(30);
    }
  });

  it("scaffolds with the framework's own command, into a sub-folder (a folder holding .hermes/ is not empty)", () => {
    expect(stackInfo("laravel")!.newProject.en).toMatch(/composer create-project laravel\/laravel my-project/);
    expect(stackInfo("flutter")!.newProject.en).toMatch(/flutter create my_app/);
    expect(stackInfo("nextjs")!.newProject.en).toMatch(/create-next-app/);
    for (const s of STACKS) expect(s.newProject.en, s.id).toMatch(/sub-folder/);
  });

  it("validates ids", () => {
    expect(isStackId("laravel")).toBe(true);
    expect(isStackId("rails")).toBe(false);
    expect(isStackId(42)).toBe(false);
  });
});
