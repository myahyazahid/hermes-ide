import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { buildPromptBlocks, contextLabel, dedupeContext, fuzzyScore } from "../../src/core/context";
import { sanitizeMcpServers, splitArgs, toAcpMcpServers, validateMcpServer } from "../../src/core/mcp";
import { parsePermission } from "../../src/core/permission";
import { HERMES_PROFILE_ID, migrateLegacyEndpoint, newProfileId, sanitizeProfiles } from "../../src/core/profiles";
import { relativeTime } from "../../src/core/time";

const cwd = path.resolve("/ws");
const file = path.join(cwd, "src", "acpClient.ts");

describe("context blocks (F-12)", () => {
  it("links files, embeds selections and lists folders, then the text", () => {
    const blocks = buildPromptBlocks(
      "ubah start()",
      [
        { kind: "file", path: file },
        { kind: "selection", path: file, startLine: 9, endLine: 14, text: "const x = 1;" },
        { kind: "folder", path: path.join(cwd, "src") },
      ],
      { cwd, folderListing: () => ["acpClient.ts", "settings.ts"] },
    );
    expect(blocks.map((b) => b.type)).toEqual(["resource_link", "resource", "resource", "text"]);
    expect(blocks[0]).toMatchObject({ type: "resource_link", uri: pathToFileURL(file).href, name: "acpClient.ts", title: "src/acpClient.ts" });
    const sel = blocks[1] as { resource: { uri: string; text: string } };
    expect(sel.resource.uri).toBe(`${pathToFileURL(file).href}#L9-L14`);
    expect(sel.resource.text).toContain("lines 9-14:\nconst x = 1;");
    expect((blocks[2] as { resource: { text: string } }).resource.text).toContain("- settings.ts");
    expect(blocks[3]).toEqual({ type: "text", text: "ubah start()" });
  });

  it("labels and dedupes references", () => {
    expect(contextLabel({ kind: "selection", path: file, startLine: 9, endLine: 14 }, cwd)).toBe("acpClient.ts · 9-14");
    expect(contextLabel({ kind: "folder", path: path.join(cwd, "src") }, cwd)).toBe("src/");
    expect(dedupeContext([{ kind: "file", path: file }, { kind: "file", path: file.toUpperCase() }])).toHaveLength(1);
  });

  it("ranks basename prefix matches first", () => {
    const files = ["src/vscode/chatView.ts", "src/core/acpClient.ts", "docs/acp-notes.md"];
    const ranked = files.map((f) => [f, fuzzyScore("acpc", f)] as const).filter(([, s]) => s >= 0).sort((a, b) => b[1] - a[1]);
    expect(ranked[0][0]).toBe("src/core/acpClient.ts");
    expect(fuzzyScore("zzz", "src/a.ts")).toBe(-1);
  });
});

describe("MCP settings (F-15)", () => {
  it("validates names, commands and URLs", () => {
    expect(validateMcpServer({ name: "fs", type: "stdio", command: "npx" })).toBeUndefined();
    expect(validateMcpServer({ name: "bad name", type: "stdio", command: "npx" })).toBe("mcp.invalidName");
    expect(validateMcpServer({ name: "x", type: "stdio" })).toBe("mcp.missingCommand");
    expect(validateMcpServer({ name: "x", type: "http", url: "ftp://a" })).toBe("mcp.invalidUrl");
    const a = { name: "x", type: "http" as const, url: "https://a" };
    expect(validateMcpServer({ ...a }, [a])).toBe("mcp.duplicateName");
  });

  it("drops invalid entries and maps to ACP shapes, skipping disabled servers", () => {
    const servers = sanitizeMcpServers([
      { name: "fs", type: "stdio", command: "npx", args: ["-y", "server"], env: { TOKEN: "t", N: 1 } },
      { name: "remote", type: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer x" } },
      { name: "off", type: "sse", url: "https://x/sse", enabled: false },
      { name: "broken", type: "stdio" },
      "nope",
    ]);
    expect(servers.map((s) => s.name)).toEqual(["fs", "remote", "off"]);
    expect(toAcpMcpServers(servers)).toEqual([
      { name: "fs", command: "npx", args: ["-y", "server"], env: [{ name: "TOKEN", value: "t" }] },
      { type: "http", name: "remote", url: "https://mcp.example.com/mcp", headers: [{ name: "Authorization", value: "Bearer x" }] },
    ]);
  });

  it("splits argument lines with quotes", () => {
    expect(splitArgs(`-y "@scope/server" --dir "C:\\My Files" 'a b'`)).toEqual(["-y", "@scope/server", "--dir", "C:\\My Files", "a b"]);
  });
});

describe("profiles (F-16)", () => {
  it("creates readable unique ids and never reuses the built-in one", () => {
    expect(newProfileId("VPS vLLM", [])).toBe("vps-vllm");
    expect(newProfileId("VPS vLLM", ["vps-vllm"])).toBe("vps-vllm-2");
    expect(HERMES_PROFILE_ID).toBe("hermes");
    expect(newProfileId("Hermes", [])).toBe("hermes-2");
    expect(newProfileId("!!!", [])).toBe("profile");
  });

  it("sanitises stored profiles", () => {
    expect(
      sanitizeProfiles([
        { id: "a", name: "A", baseUrl: " https://a/v1 ", model: "m", contextLength: 128000 },
        { id: "a", name: "dup" },
        { id: "hermes", name: "reserved" },
        { name: "no id" },
      ]),
    ).toEqual([{ id: "a", name: "A", baseUrl: "https://a/v1", model: "m", contextLength: 128000 }]);
  });

  it("migrates the Phase 1 endpoint settings", () => {
    expect(migrateLegacyEndpoint({ mode: "custom", baseUrl: "https://x/v1", model: "m", contextLength: 0 })).toEqual({
      profile: { id: "custom-api", name: "Custom API", baseUrl: "https://x/v1", model: "m", contextLength: undefined },
      active: true,
    });
    expect(migrateLegacyEndpoint({ mode: "hermes", baseUrl: "" })).toBeUndefined();
  });
});

describe("hook permissions (story 4)", () => {
  it("recovers the real command from a hook escalation", () => {
    const parsed = parsePermission({
      sessionId: "s",
      toolCall: {
        toolCallId: "perm-check-2", title: "[hermes-ide] terminal: npm run compile: <terminal> (plugin approval rule)", kind: "execute",
        rawInput: { command: "<terminal> (plugin approval rule)", description: "[hermes-ide] terminal: npm run compile" },
      },
      options: [{ optionId: "allow_once", kind: "allow_once", name: "Allow once" }],
    });
    expect(parsed).toEqual({ variant: "execute", command: "npm run compile", description: "", viaHook: true, tool: "terminal" });
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-10-09T10:00:00Z");
  it("formats ISO strings and epoch seconds", () => {
    expect(relativeTime("2026-10-09T09:58:00Z", "en", now)).toBe("2 minutes ago");
    expect(relativeTime(String(now / 1000 - 3 * 3600), "en", now)).toBe("3 hours ago");
    expect(relativeTime("2026-10-08T10:00:00Z", "id", now)).toBe("kemarin");
    expect(relativeTime(undefined, "en", now)).toBe("");
  });
});
