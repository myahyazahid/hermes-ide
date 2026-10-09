// End-to-end: the real `hermes acp` driven by AcpClient, with the model replaced by the local
// OpenAI mock so tool calls are deterministic and nothing leaves the machine.
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AcpClient } from "../../src/core/acpClient";
import { buildLaunchEnv, buildProfileConfigYaml } from "../../src/core/endpoint";
import { locateHermes } from "../../src/core/hermesLocator";
import { parsePermission, pickOption, selected } from "../../src/core/permission";
import { Transcript } from "../../src/core/transcript";
import { startOpenAIMock, type OpenAIMock } from "../fixtures/openai-mock.mjs";

const hermes = locateHermes();
const API_KEY = "sk-integration-test";

type PermissionAnswer = "allow_once" | "reject";

describe.skipIf(!hermes)("hermes acp (real process, mock model)", () => {
  let mock: OpenAIMock;
  let root: string;
  let ws: string;
  let env: NodeJS.ProcessEnv;
  let client: AcpClient;
  let sessionId: string;
  let transcript: Transcript;
  const permissions: acp.RequestPermissionRequest[] = [];
  const stderr: string[] = [];
  let answer: PermissionAnswer = "allow_once";

  async function startClient(): Promise<AcpClient> {
    return AcpClient.start(
      { command: hermes!, cwd: ws, env },
      {
        onSessionUpdate: (n) => transcript.apply(n.update),
        onPermission: async (req) => {
          permissions.push(req);
          return selected(pickOption(req.options, answer));
        },
        onLog: (line) => stderr.push(line),
        onExit: () => {},
      },
      { name: "hermes-ide-test", version: "0.0.0" },
    );
  }

  beforeAll(async () => {
    mock = await startOpenAIMock({ apiKey: API_KEY, models: [{ id: "mock-model", context_length: 128000 }] });
    root = await mkdtemp(path.join(os.tmpdir(), "hermes-ide-it-"));
    ws = path.join(root, "ws");
    const home = path.join(root, "home");
    await mkdir(ws, { recursive: true });
    await mkdir(home, { recursive: true });
    const custom = { baseUrl: mock.baseUrl, model: "mock-model", apiKey: API_KEY, contextLength: 128000 };
    await writeFile(path.join(home, "config.yaml"), buildProfileConfigYaml(custom));
    env = buildLaunchEnv({ parentEnv: process.env, mode: "custom", custom, profileHome: home });

    transcript = new Transcript();
    client = await startClient();
    const auth = client.init?.authMethods?.find((m) => !("type" in m && m.type === "terminal"));
    expect(auth).toBeDefined();
    await client.authenticate(auth!.id);
    const session = await client.newSession(ws);
    sessionId = session.sessionId;
    expect(session.models?.currentModelId).toContain("mock-model");
  });

  afterAll(async () => {
    await client?.stop();
    await mock?.close();
    if (root) await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  const prompt = (text: string) => client.prompt(sessionId, [{ type: "text", text }]);

  it("streams a reply through the custom endpoint, with the key only in the environment", async () => {
    mock.script([{ text: "Halo dari mock" }]);
    transcript = new Transcript();
    const res = await prompt("hai");
    expect(res.stopReason).toBe("end_turn");
    expect(transcript.all().find((i) => i.kind === "agent")).toMatchObject({ text: "Halo dari mock" });
    const agentCalls = mock.chatRequests().filter((r) => r.body?.tools?.length);
    expect(agentCalls.at(-1)?.auth).toBe(`Bearer ${API_KEY}`);
    expect(agentCalls.at(-1)?.body.model).toBe("mock-model");
    const config = await readFile(path.join(root, "home", "config.yaml"), "utf8");
    expect(config).not.toContain(API_KEY);
  });

  it("asks before creating a file and writes it once allowed", async () => {
    const target = path.join(ws, "hello.txt");
    mock.script([{ toolCalls: [{ name: "write_file", arguments: { path: target, content: "hello\n" } }] }, { text: "done" }]);
    permissions.length = 0;
    answer = "allow_once";
    transcript = new Transcript();
    expect((await prompt("buat hello.txt")).stopReason).toBe("end_turn");

    expect(permissions).toHaveLength(1);
    const parsed = parsePermission(permissions[0]);
    expect(parsed).toMatchObject({ variant: "edit", oldText: null, newText: "hello\n", isPatch: false });
    expect(await readFile(target, "utf8")).toBe("hello\n");
    const tool = transcript.all().find((i) => i.kind === "tool");
    expect(tool).toMatchObject({ toolKind: "edit", status: "completed" });
  });

  it("leaves the file untouched when the edit is rejected", async () => {
    const target = path.join(ws, "rejected.txt");
    mock.script([{ toolCalls: [{ name: "write_file", arguments: { path: target, content: "nope\n" } }] }, { text: "ok, skipped" }]);
    permissions.length = 0;
    answer = "reject";
    expect((await prompt("buat rejected.txt")).stopReason).toBe("end_turn");
    expect(permissions).toHaveLength(1);
    expect(existsSync(target)).toBe(false);
    // The model was told the edit was denied.
    const last = mock.chatRequests().filter((r) => r.body?.tools?.length).at(-1);
    expect(JSON.stringify(last?.body.messages)).toContain("denied");
  });

  it("sends the current and proposed text for a replace patch", async () => {
    const target = path.join(ws, "app.ts");
    await writeFile(target, "a\nb\nc\n");
    mock.script([
      { toolCalls: [{ name: "patch", arguments: { mode: "replace", path: target, old_string: "b", new_string: "B" } }] },
      { text: "patched" },
    ]);
    permissions.length = 0;
    answer = "allow_once";
    expect((await prompt("ubah b jadi B")).stopReason).toBe("end_turn");
    const parsed = parsePermission(permissions[0]);
    expect(parsed).toMatchObject({ variant: "edit", oldText: "a\nb\nc\n", newText: "a\nB\nc\n" });
    expect((await readFile(target, "utf8")).replace(/\r\n/g, "\n")).toBe("a\nB\nc\n");
  });

  it("asks before a dangerous command and does not run it when rejected", async () => {
    const victim = path.join(ws, "victim");
    await mkdir(victim, { recursive: true });
    await writeFile(path.join(victim, "keep.txt"), "x");
    const command = `rm -rf "${victim.replace(/\\/g, "/")}"`;
    mock.script([{ toolCalls: [{ name: "terminal", arguments: { command } }] }, { text: "not deleted" }]);
    permissions.length = 0;
    answer = "reject";
    expect((await prompt("hapus victim")).stopReason).toBe("end_turn");
    expect(permissions).toHaveLength(1);
    expect(parsePermission(permissions[0])).toMatchObject({ variant: "execute", command });
    expect(existsSync(path.join(victim, "keep.txt"))).toBe(true);
  });

  it("runs ordinary commands without asking (Hermes only gates risky ones)", async () => {
    mock.script([{ toolCalls: [{ name: "terminal", arguments: { command: "echo hermes-ide-ok" } }] }, { text: "ran" }]);
    permissions.length = 0;
    transcript = new Transcript();
    expect((await prompt("jalankan echo")).stopReason).toBe("end_turn");
    expect(permissions).toHaveLength(0);
    const tool = transcript.all().find((i) => i.kind === "tool");
    expect(tool).toMatchObject({ toolKind: "execute", status: "completed" });
  });

  it("cancels a running turn", async () => {
    mock.script([{ text: "slow", delayMs: 15_000 }]);
    const started = Date.now();
    const running = prompt("tunggu");
    await new Promise((r) => setTimeout(r, 1500));
    client.cancel(sessionId);
    const res = await running;
    expect(res.stopReason).toBe("cancelled");
    expect(Date.now() - started).toBeLessThan(12_000);
  });

  it("resumes the session in a fresh process (restart without losing the conversation)", async () => {
    await client.stop();
    expect(client.isAlive).toBe(false);
    transcript = new Transcript();
    client = await startClient();
    const auth = client.init?.authMethods?.find((m) => !("type" in m && m.type === "terminal"));
    await client.authenticate(auth!.id);
    const loaded = await client.loadSession(ws, sessionId);
    expect(loaded).not.toBeNull();
    // Hermes replays the history before answering session/load.
    expect(transcript.all().some((i) => i.kind === "user" && i.text.includes("hai"))).toBe(true);
    mock.script([{ text: "masih di sini" }]);
    expect((await prompt("masih?")).stopReason).toBe("end_turn");
  });

  it("stops the whole process tree", async () => {
    const pid = client.pid!;
    await client.stop();
    await new Promise((r) => setTimeout(r, 300));
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
