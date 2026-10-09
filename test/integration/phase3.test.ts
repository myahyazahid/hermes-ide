// Phase 3 against the real `hermes acp`: the IDE's in-process MCP HTTP server is reachable from
// Hermes, so the agent can call IDE tools such as codebase_search (F-18).
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AcpClient } from "../../src/core/acpClient";
import { buildLaunchEnv, buildProfileConfigYaml } from "../../src/core/endpoint";
import { locateHermes } from "../../src/core/hermesLocator";
import { McpHttpServer } from "../../src/core/mcpHttpServer";
import { startOpenAIMock, type OpenAIMock } from "../fixtures/openai-mock.mjs";

const hermes = locateHermes();

describe.skipIf(!hermes)("IDE MCP server (real hermes)", () => {
  let mock: OpenAIMock;
  let root: string;
  let client: AcpClient;
  const calls: Record<string, unknown>[] = [];
  const logs: string[] = [];
  const server = new McpHttpServer(
    () => [{
      name: "codebase_search",
      description: "Semantic search over the workspace.",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      call: async (args) => {
        calls.push(args);
        return { text: `src/auth.ts:10-20 (score 0.91)\nexport function login() {}` };
      },
    }],
    { name: "hermes-ide", version: "test" },
  );

  beforeAll(async () => {
    mock = await startOpenAIMock({ models: [{ id: "mock-model", context_length: 128000 }] });
    root = await mkdtemp(path.join(os.tmpdir(), "hermes-ide-p3-"));
    const ws = path.join(root, "ws");
    const home = path.join(root, "home");
    await mkdir(ws, { recursive: true });
    await mkdir(home, { recursive: true });
    const custom = { baseUrl: mock.baseUrl, model: "mock-model", contextLength: 128000 };
    await writeFile(path.join(home, "config.yaml"), buildProfileConfigYaml(custom));
    const env = buildLaunchEnv({ parentEnv: process.env, mode: "custom", custom, profileHome: home });
    client = await AcpClient.start(
      { command: hermes!, cwd: ws, env },
      { onSessionUpdate: () => {}, onPermission: async () => ({ outcome: { outcome: "cancelled" } }), onLog: (l) => logs.push(l), onExit: () => {} },
      { name: "hermes-ide-test", version: "0.0.0" },
    );
    await client.authenticate("custom");
  });

  afterAll(async () => {
    await client?.stop();
    await server.close();
    await mock?.close();
    if (root) await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it("registers the IDE tools over HTTP and lets the agent call them with the token", async () => {
    const url = await server.start();
    const session = await client.newSession(path.join(root, "ws"), [
      { type: "http", name: "hermes-ide", url, headers: [{ name: "Authorization", value: `Bearer ${server.token}` }] },
    ]);
    const deadline = Date.now() + 30_000;
    while (!logs.some((l) => l.includes("mcp__hermes_ide__codebase_search") || l.includes("mcp__hermes-ide__codebase_search")) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
    }
    const registered = logs.find((l) => /registered \d+ tool\(s\): .*codebase_search/.test(l));
    expect(registered, logs.filter((l) => /mcp/i.test(l)).slice(-5).join("\n")).toBeDefined();
    const toolName = /(mcp__\S*codebase_search)/.exec(registered!)![1];
    mock.script([{ toolCalls: [{ name: "tool_call", arguments: { calls: [{ name: toolName, arguments: { query: "where is login" } }] } }] }, { text: "found" }]);
    await client.prompt(session.sessionId, [{ type: "text", text: "cari login" }]);
    expect(calls).toEqual([{ query: "where is login" }]);
    const last = mock.chatRequests().filter((r) => r.body?.tools?.length).at(-1)!;
    expect(JSON.stringify(last.body.messages)).toContain("export function login()");
  });

  it("rejects requests without the token", async () => {
    const res = await fetch(server.url, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(res.status).toBe(401);
  });
});
