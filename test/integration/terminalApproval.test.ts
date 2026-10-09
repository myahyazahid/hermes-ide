// User story 4: with the IDE's pre_tool_call hook installed, *every* terminal command reaches the
// permission card, not only the ones Hermes considers dangerous.
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
import { HOOK_ENV, HOOK_SCRIPT, HOOK_SCRIPT_NAME, hookCommand, withAllowlistEntry, withApprovalHook } from "../../src/core/terminalApproval";
import { startOpenAIMock, type OpenAIMock } from "../fixtures/openai-mock.mjs";

const hermes = locateHermes();

describe.skipIf(!hermes)("terminal approval hook (real hermes)", () => {
  let mock: OpenAIMock;
  let root: string;
  let ws: string;
  let client: AcpClient;
  let sessionId: string;
  const permissions: acp.RequestPermissionRequest[] = [];
  let answer: "allow_once" | "reject" = "allow_once";

  beforeAll(async () => {
    mock = await startOpenAIMock({ models: [{ id: "mock-model", context_length: 128000 }] });
    root = await mkdtemp(path.join(os.tmpdir(), "hermes-ide-hook-"));
    ws = path.join(root, "ws");
    const home = path.join(root, "home");
    await mkdir(ws, { recursive: true });
    await mkdir(home, { recursive: true });
    const script = path.join(root, HOOK_SCRIPT_NAME);
    await writeFile(script, HOOK_SCRIPT);
    const command = hookCommand(process.execPath, script);
    const custom = { baseUrl: mock.baseUrl, model: "mock-model", contextLength: 128000 };
    await writeFile(path.join(home, "config.yaml"), withApprovalHook(buildProfileConfigYaml(custom), command));
    await writeFile(path.join(home, "shell-hooks-allowlist.json"), withAllowlistEntry("", command));
    const env = { ...buildLaunchEnv({ parentEnv: process.env, mode: "custom", custom, profileHome: home }), [HOOK_ENV]: "1" };

    client = await AcpClient.start(
      { command: hermes!, cwd: ws, env },
      {
        onSessionUpdate: () => {},
        onPermission: async (req) => {
          permissions.push(req);
          return selected(pickOption(req.options, answer));
        },
        onLog: () => {},
        onExit: () => {},
      },
      { name: "hermes-ide-test", version: "0.0.0" },
    );
    const auth = client.init?.authMethods?.find((m) => !("type" in m && m.type === "terminal"));
    await client.authenticate(auth!.id);
    sessionId = (await client.newSession(ws)).sessionId;
  });

  afterAll(async () => {
    await client?.stop();
    await mock?.close();
    if (root) await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it("asks before an ordinary command and runs it once allowed", async () => {
    const marker = path.join(ws, "ran.txt").replace(/\\/g, "/");
    const command = `echo ok > "${marker}"`;
    mock.script([{ toolCalls: [{ name: "terminal", arguments: { command } }] }, { text: "done" }]);
    permissions.length = 0;
    answer = "allow_once";
    expect((await client.prompt(sessionId, [{ type: "text", text: "run" }])).stopReason).toBe("end_turn");
    expect(permissions).toHaveLength(1);
    expect(parsePermission(permissions[0])).toMatchObject({ variant: "execute", command, viaHook: true });
    expect(existsSync(marker)).toBe(true);
  });

  it("does not run an ordinary command when rejected", async () => {
    const marker = path.join(ws, "never.txt").replace(/\\/g, "/");
    mock.script([{ toolCalls: [{ name: "terminal", arguments: { command: `echo no > "${marker}"` } }] }, { text: "skipped" }]);
    permissions.length = 0;
    answer = "reject";
    await client.prompt(sessionId, [{ type: "text", text: "run" }]);
    expect(permissions).toHaveLength(1);
    expect(existsSync(marker)).toBe(false);
  });

  it("still runs Hermes' own danger check after the hook card (the IDE answers it once)", async () => {
    const victim = path.join(ws, "victim");
    await mkdir(victim, { recursive: true });
    const command = `rm -rf "${victim.replace(/\\/g, "/")}"`;
    mock.script([{ toolCalls: [{ name: "terminal", arguments: { command } }] }, { text: "done" }]);
    permissions.length = 0;
    answer = "allow_once";
    await client.prompt(sessionId, [{ type: "text", text: "hapus" }]);
    const parsed = permissions.map(parsePermission);
    expect(parsed[0]).toMatchObject({ variant: "execute", command, viaHook: true });
    expect(parsed[1]).toMatchObject({ variant: "execute", command });
    expect(parsed[1]).not.toHaveProperty("viaHook");
    expect(existsSync(victim)).toBe(false);
  });

  it("is inert outside the IDE (env flag missing)", async () => {
    // The same hook command run by hand without the flag must print nothing and exit 0.
    const { execFileSync } = await import("node:child_process");
    const script = path.join(root, HOOK_SCRIPT_NAME);
    const env = { ...process.env };
    delete env[HOOK_ENV];
    const out = execFileSync(process.execPath, [script], { input: JSON.stringify({ tool_name: "terminal", tool_input: { command: "ls" } }), env });
    expect(out.toString()).toBe("");
    expect(await readFile(script, "utf8")).toContain(HOOK_ENV);
  });
});
