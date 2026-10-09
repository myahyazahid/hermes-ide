// Phase 2 against the real `hermes acp`: @file/selection context (F-12), session list / resume /
// delete (F-14) and IDE-provided MCP servers (F-15).
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AcpClient } from "../../src/core/acpClient";
import { readFileSync } from "node:fs";
import { buildPromptBlocks, decodeFile } from "../../src/core/context";
import { buildLaunchEnv, buildProfileConfigYaml } from "../../src/core/endpoint";
import { locateHermes } from "../../src/core/hermesLocator";
import { toAcpMcpServers } from "../../src/core/mcp";
import { Transcript } from "../../src/core/transcript";
import { startOpenAIMock, type OpenAIMock } from "../fixtures/openai-mock.mjs";

const hermes = locateHermes();
const echoServer = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "mcp-echo.mjs");

describe.skipIf(!hermes)("phase 2 (real hermes, mock model)", () => {
  let mock: OpenAIMock;
  let root: string;
  let ws: string;
  let env: NodeJS.ProcessEnv;
  let client: AcpClient;
  let transcript = new Transcript();
  const logs: string[] = [];

  const start = async () => {
    const c = await AcpClient.start(
      { command: hermes!, cwd: ws, env },
      {
        onSessionUpdate: (n) => transcript.apply(n.update),
        onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        onLog: (l) => logs.push(l),
        onExit: () => {},
      },
      { name: "hermes-ide-test", version: "0.0.0" },
    );
    const auth = c.init?.authMethods?.find((m) => !("type" in m && m.type === "terminal"));
    await c.authenticate(auth!.id);
    return c;
  };
  const lastAgentRequest = () => mock.chatRequests().filter((r) => r.body?.tools?.length).at(-1)!;

  beforeAll(async () => {
    mock = await startOpenAIMock({ models: [{ id: "mock-model", context_length: 128000 }] });
    root = await mkdtemp(path.join(os.tmpdir(), "hermes-ide-p2-"));
    ws = path.join(root, "ws");
    const home = path.join(root, "home");
    await mkdir(path.join(ws, "src"), { recursive: true });
    await mkdir(home, { recursive: true });
    const custom = { baseUrl: mock.baseUrl, model: "mock-model", contextLength: 128000 };
    await writeFile(path.join(home, "config.yaml"), buildProfileConfigYaml(custom));
    env = buildLaunchEnv({ parentEnv: process.env, mode: "custom", custom, profileHome: home });
    client = await start();
  });

  afterAll(async () => {
    await client?.stop();
    await mock?.close();
    if (root) await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it("inlines @file and selection context into the model request (F-12)", async () => {
    const file = path.join(ws, "src", "settings.ts");
    await writeFile(file, "export const BASE_URL = 'https://unique-marker.example';\n");
    const session = await client.newSession(ws);
    mock.script([{ text: "Dilihat." }]);
    const blocks = buildPromptBlocks("jelaskan file ini", [
      { kind: "file", path: file },
      { kind: "selection", path: file, startLine: 1, endLine: 1, text: "SELECTED-LINE-MARKER" },
    ], { cwd: ws, readFile: (f) => decodeFile(f, readFileSync(f)) });
    expect((await client.prompt(session.sessionId, blocks)).stopReason).toBe("end_turn");
    const user = JSON.stringify(lastAgentRequest().body.messages.filter((m: { role: string }) => m.role === "user"));
    expect(user).toContain("unique-marker.example");
    expect(user).toContain("SELECTED-LINE-MARKER");
    expect(user).toContain("jelaskan file ini");
  });

  it("exposes IDE-provided MCP tools to the model and runs them (F-15)", async () => {
    const servers = toAcpMcpServers([{ name: "ideecho", type: "stdio", command: process.execPath, args: [echoServer] }]);
    const session = await client.newSession(ws, servers);
    // Hermes registers MCP tools in the background and lists them behind tool_search (deferred),
    // so wait for the registration log instead of looking at the initial tool list.
    const deadline = Date.now() + 30_000;
    while (!logs.some((l) => l.includes("mcp__ideecho__echo")) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
    expect(logs.some((l) => l.includes("registered 1 tool(s): mcp__ideecho__echo"))).toBe(true);
    const toolName = "mcp__ideecho__echo";
    // Deferred tools are invoked through Hermes' tool_call bridge, as a real model would.
    mock.script([{ toolCalls: [{ name: "tool_call", arguments: { calls: [{ name: toolName, arguments: { text: "halo-mcp" } }] } }] }, { text: "selesai" }]);
    await client.prompt(session.sessionId, [{ type: "text", text: "panggil echo" }]);
    expect(JSON.stringify(lastAgentRequest().body.messages)).toContain("echo: halo-mcp");
  });

  it("lists sessions for the workspace, resumes one with its history, and deletes it (F-14)", async () => {
    const session = await client.newSession(ws);
    mock.script([{ text: "Jawaban pertama." }]);
    await client.prompt(session.sessionId, [{ type: "text", text: "pesan-riwayat-unik" }]);

    const listed = await client.listSessions(ws);
    expect(listed.some((s) => s.sessionId === session.sessionId)).toBe(true);
    expect(listed.find((s) => s.sessionId === session.sessionId)?.title).toBeTruthy();

    // Resume in a fresh process: the replay rebuilds the transcript.
    await client.stop();
    transcript = new Transcript();
    client = await start();
    expect(await client.loadSession(ws, session.sessionId)).not.toBeNull();
    const items = transcript.all();
    expect(items.some((i) => i.kind === "user" && i.text.includes("pesan-riwayat-unik"))).toBe(true);
    expect(items.some((i) => i.kind === "agent" && i.text.includes("Jawaban pertama."))).toBe(true);

    // Delete through the Hermes CLI, as the IDE does, then a fresh process no longer lists it.
    await client.stop();
    execFileSync(hermes!, ["sessions", "delete", session.sessionId, "--yes"], { env, windowsHide: true });
    client = await start();
    expect((await client.listSessions(ws)).some((s) => s.sessionId === session.sessionId)).toBe(false);
  });
});
