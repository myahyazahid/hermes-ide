import { describe, expect, it } from "vitest";
import { isSearchQuery, isSkillIdentifier, isSkillName, parseInstalledSkills, parseSearchResults } from "../../src/core/skills";

const TABLE = `                    Installed Skills                    \r
┌────────────────┬──────────┬────────┬───────┬─────────┐\r
│ Name           │ Category │ Source │ Trust │ Status  │\r
├────────────────┼──────────┼────────┼───────┼─────────┤\r
│ my-local-skill │ notes    │ local  │ local │ enabled │\r
│ gitnexus       │ research │ official │ builtin │ disabled │\r
└────────────────┴──────────┴────────┴───────┴─────────┘\r
1 hub-installed, 0 builtin, 1 local — 1 enabled, 1 disabled\r
`;

describe("parseInstalledSkills", () => {
  it("reads the rows of Hermes' table and skips the header, borders and summary", () => {
    expect(parseInstalledSkills(TABLE)).toEqual([
      { name: "my-local-skill", category: "notes", source: "local", trust: "local", enabled: true },
      { name: "gitnexus", category: "research", source: "official", trust: "builtin", enabled: false },
    ]);
  });

  it("gives nothing for an empty table or noise", () => {
    expect(parseInstalledSkills("┌──┐\n│ Name │ Category │ Source │ Trust │ Status │\n└──┘\n0 hub-installed")).toEqual([]);
    expect(parseInstalledSkills("")).toEqual([]);
  });
});

describe("parseSearchResults", () => {
  const json = JSON.stringify([
    { name: "watchers", identifier: "official/devops/watchers", source: "official", trust_level: "builtin", description: "Poll RSS." },
    { name: "x", identifier: "bad id; rm -rf /", source: "github", trust_level: "community", description: "never offered" },
    { identifier: "openai/skills/skill-creator", source: "openai" },
    "junk",
  ]);

  it("returns the hits Hermes found, skipping identifiers that could not be passed safely", () => {
    expect(parseSearchResults(json)).toEqual([
      { name: "watchers", identifier: "official/devops/watchers", source: "official", trust: "builtin", description: "Poll RSS." },
      { name: "skill-creator", identifier: "openai/skills/skill-creator", source: "openai", trust: "", description: "" },
    ]);
  });

  it("ignores text around the JSON, and broken output", () => {
    expect(parseSearchResults(`Searching...\n${json}\nDone`)).toHaveLength(2);
    expect(parseSearchResults("no results")).toEqual([]);
    expect(parseSearchResults("[not json]")).toEqual([]);
  });
});

describe("validation of what reaches the command line", () => {
  it.each([
    ["official/devops/watchers", true],
    ["openai/skills/skill-creator", true],
    ["owner/repo/path.v2/skill@1", true],
    ["", false],
    ["a b", false],
    ["a;b", false],
    ["a/../b", false], // a segment must start with a letter or digit, so no path tricks
    ["$(calc)", false],
    ["https://example.com/SKILL.md", false],
    ["-rf", false],
    ["a&b", false],
  ])("identifier %j -> %s", (value, expected) => {
    expect(isSkillIdentifier(value)).toBe(expected);
  });

  it("validates skill names and search queries", () => {
    expect(isSkillName("my-local-skill")).toBe(true);
    expect(isSkillName("../x")).toBe(false);
    expect(isSkillName("a b")).toBe(false);
    expect(isSearchQuery("git merge")).toBe(true);
    expect(isSearchQuery("pencarian skill")).toBe(true);
    expect(isSearchQuery('x"; calc')).toBe(false);
    expect(isSearchQuery("   ")).toBe(false);
    expect(isSearchQuery("a".repeat(81))).toBe(false);
  });
});
