// Runs inside a real VS Code extension host (launched by runTest.mjs). Drives the extension the
// way the panel does, against the real `hermes acp` and the scripted OpenAI mock.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { HermesIdeApi } from "../../src/extension";
import type { TranscriptItem } from "../../src/shared/protocol";
import type { AgentLog } from "../../src/vscode/agentLog";
import { HermesMaintenance, type MaintenanceHost } from "../../src/vscode/hermesMaintenance";
import { IdeUpdater } from "../../src/vscode/ideUpdater";

const MOCK = process.env.HERMES_IT_MOCK_URL!;
const CONTROL = MOCK.replace(/\/v1$/, "");

async function script(replies: unknown[]): Promise<void> {
  await fetch(`${CONTROL}/__script`, { method: "POST", body: JSON.stringify(replies) });
}

async function fim(replies: { text: string; delayMs?: number }[]): Promise<void> {
  await fetch(`${CONTROL}/__fim`, { method: "POST", body: JSON.stringify(replies) });
}

async function requestsTo(apiPath: string): Promise<any[]> {
  return (await (await fetch(`${CONTROL}/__requests?path=${encodeURIComponent(apiPath)}`)).json()) as any[];
}

async function agentRequests(): Promise<any[]> {
  const all = (await (await fetch(`${CONTROL}/__requests`)).json()) as any[];
  return all.filter((b) => Array.isArray(b?.tools) && b.tools.length);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(probe: () => T | undefined | false | null, what: string, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = probe();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

function equal<T>(actual: T, expected: T, msg: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function ok(value: unknown, msg: string): void {
  if (!value) throw new Error(msg);
}

const seenReviews = new Set<string>();

let lastReviewUri: vscode.Uri | undefined;

/** Waits for a new diff review editor and returns its review id. */
async function nextReview(): Promise<string> {
  return waitFor(() => {
    for (const ed of vscode.window.visibleTextEditors) {
      if (ed.document.uri.scheme !== "hermes-diff") continue;
      const id = ed.document.uri.path.split("/")[1];
      if (id && !seenReviews.has(id)) {
        seenReviews.add(id);
        lastReviewUri = ed.document.uri;
        return id;
      }
    }
    return undefined;
  }, "diff review editor");
}

/** Like the CodeLens buttons: decide on the review just opened, independent of editor focus. */
const decideReview = (accept: boolean) => vscode.commands.executeCommand(accept ? "hermes.diff.accept" : "hermes.diff.reject", lastReviewUri);

const lnf = (s: string) => s.replace(/\r\n/g, "\n");

export async function run(): Promise<void> {
  const ext = vscode.extensions.all.find((e) => e.packageJSON.name === "hermes-ide");
  ok(ext, "extension not found");
  const api = (await ext!.activate()) as HermesIdeApi;
  const svc = api.service;
  const ws = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const items = () => svc.transcriptItems();
  const permissionItems = () => items().filter((i): i is Extract<TranscriptItem, { kind: "permission" }> => i.kind === "permission");

  const tests: [string, () => Promise<void>][] = [
    ["registers its commands", async () => {
      const commands = await vscode.commands.getCommands(true);
      for (const c of ["hermes.openChat", "hermes.newSession", "hermes.stop", "hermes.restart", "hermes.diff.accept", "hermes.diff.reject", "hermes.exportLogs"]) {
        ok(commands.includes(c), `missing command ${c}`);
      }
    }],

    ["opening the panel boots the webview and starts Hermes in the workspace (F-01, F-03)", async () => {
      await vscode.commands.executeCommand("hermes.openChat");
      // Only the webview's own "ready" message starts Hermes, so reaching "ready" proves the UI loaded.
      await waitFor(() => svc.state.phase === "ready", "phase ready", 90_000);
      equal(svc.state.cwd, ws, "cwd bound to workspace");
      ok(svc.state.currentModelId?.includes("mock-model"), `model ${svc.state.currentModelId}`);
      ok(svc.processId, "hermes pid");
    }],

    ["Tes koneksi reports the custom endpoint as healthy (F-04)", async () => {
      await svc.handleViewMessage({ type: "testEndpoint", baseUrl: MOCK, model: "mock-model", contextLength: 0 });
      await waitFor(() => !svc.state.test.running, "test finished");
      ok(svc.state.test.ok, `test failed: ${svc.state.test.message} ${svc.state.test.detail ?? ""}`);
    }],

    ["completes a multi-file edit task from the panel, accepting each diff (F-06, F-07, F-09)", async () => {
      const a = path.join(ws, "src", "a.ts");
      const b = path.join(ws, "src", "b.ts");
      await script([
        { text: "Membuat dua file.", toolCalls: [{ name: "write_file", arguments: { path: a, content: "export const a = 1;\n" } }] },
        { toolCalls: [{ name: "write_file", arguments: { path: b, content: "export const b = 2;\n" } }] },
        { text: "Dua file dibuat." },
      ]);
      const sending = svc.handleViewMessage({ type: "send", text: "buat a.ts dan b.ts" });
      for (let i = 0; i < 2; i++) {
        await nextReview();
        await decideReview(true);
      }
      await sending;
      equal(lnf(readFileSync(a, "utf8")), "export const a = 1;\n", "a.ts");
      equal(lnf(readFileSync(b, "utf8")), "export const b = 2;\n", "b.ts");
      const perms = permissionItems().slice(-2);
      equal(perms.map((p) => p.state), ["allowed", "allowed"], "permission cards");
      const tools = items().filter((i) => i.kind === "tool");
      ok(tools.some((t) => t.kind === "tool" && t.toolKind === "edit" && t.status === "completed"), "edit tool card");
      ok(items().some((i) => i.kind === "agent" && i.text.includes("Dua file dibuat.")), "final reply");
      equal(svc.state.busy, false, "not busy");
    }],

    ["rejecting a diff leaves the file untouched (F-09)", async () => {
      const c = path.join(ws, "src", "c.ts");
      await script([{ toolCalls: [{ name: "write_file", arguments: { path: c, content: "nope\n" } }] }, { text: "Oke." }]);
      const sending = svc.handleViewMessage({ type: "send", text: "buat c.ts" });
      await nextReview();
      await decideReview(false);
      await sending;
      ok(!existsSync(c), "c.ts must not exist");
      equal(permissionItems().at(-1)?.state, "rejected", "card state");
    }],

    ["accepting only some hunks reverts the others and tells Hermes (F-09 per hunk)", async () => {
      const d = path.join(ws, "d.txt");
      writeFileSync(d, ["a", "b", "c", "d", "e", "f", "g"].join("\n") + "\n");
      const proposed = ["a", "B", "c", "d", "e", "F", "g"].join("\n") + "\n";
      // Hermes refuses to overwrite a file the agent has not read in full, so read it first like a real model.
      await script([
        { toolCalls: [{ name: "read_file", arguments: { path: d } }] },
        { toolCalls: [{ name: "write_file", arguments: { path: d, content: proposed } }] },
        { text: "Diubah." },
      ]);
      const sending = svc.handleViewMessage({ type: "send", text: "ubah b dan f" });
      const reviewId = await nextReview();
      equal(api.reviews.hunkCount(reviewId), 2, "hunks");
      await vscode.commands.executeCommand("hermes.diff.toggleHunk", reviewId, 1);
      await decideReview(true);
      await sending;
      const expected = ["a", "B", "c", "d", "e", "f", "g"].join("\n") + "\n";
      await waitFor(() => lnf(readFileSync(d, "utf8")) === expected, "partial revert", 15_000).catch(async (e: Error) => {
        const notices = items().filter((i) => i.kind === "notice" || i.kind === "permission").slice(-3);
        const toolMsgs = (await agentRequests()).at(-1).messages.filter((m: any) => m.role === "tool").slice(-2).map((m: any) => String(m.content).slice(0, 400));
        throw new Error(`${e.message}; file=${JSON.stringify(readFileSync(d, "utf8"))}; tools=${JSON.stringify(toolMsgs)}; card=${JSON.stringify(notices.slice(-1).map((n: any) => [n.state, n.resolution]))} active=${vscode.window.activeTextEditor?.document.uri.toString()} hunks=${api.reviews.hunkCount(reviewId)}`);
      });

      await script([{ text: "Siap." }]);
      await svc.handleViewMessage({ type: "send", text: "lanjut" });
      const last = (await agentRequests()).at(-1);
      const userTexts = JSON.stringify(last.messages.filter((m: any) => m.role === "user"));
      ok(userTexts.includes("accepted only part"), "partial-accept note sent to Hermes");
    }],

    ["dangerous commands get a permission card without 'always allow'; rejecting stops them (F-08)", async () => {
      const victim = path.join(ws, "victim");
      mkdirSync(victim, { recursive: true });
      writeFileSync(path.join(victim, "keep.txt"), "x");
      const command = `rm -rf "${victim.replace(/\\/g, "/")}"`;
      await script([{ toolCalls: [{ name: "terminal", arguments: { command } }] }, { text: "Tidak dihapus." }]);
      const sending = svc.handleViewMessage({ type: "send", text: "hapus victim" });
      const card = await waitFor(() => permissionItems().find((p) => p.state === "pending" && p.variant === "execute"), "execute card");
      equal(card.command, command, "command shown");
      ok(card.dangerReason, "danger reason shown");
      ok(!card.actions.includes("allow_always_ws"), "no always-allow for dangerous commands");
      await svc.handleViewMessage({ type: "permission", id: card.id, action: "reject" });
      await sending;
      ok(existsSync(path.join(victim, "keep.txt")), "victim must survive");
    }],

    ["Stop cancels a running turn (F-10)", async () => {
      await script([{ text: "lambat", delayMs: 20_000 }]);
      const started = Date.now();
      const sending = svc.handleViewMessage({ type: "send", text: "tunggu" });
      await waitFor(() => svc.state.busy, "busy");
      await sleep(1000);
      await svc.handleViewMessage({ type: "stop" });
      await sending;
      equal(svc.state.busy, false, "busy after stop");
      ok(Date.now() - started < 15_000, "stopped quickly");
    }],

    // ---- Phase 2 ------------------------------------------------------------------------

    ["story 4: every ordinary terminal command asks first; 'always allow' skips the card next time", async () => {
      equal(svc.state.terminalApproval, "active", "approval hook active");
      const marker = path.join(ws, "ran.txt").replace(/\\/g, "/");
      const command = `echo ok > "${marker}"`;
      await script([{ toolCalls: [{ name: "terminal", arguments: { command } }] }, { text: "Selesai." }]);
      const sending = svc.handleViewMessage({ type: "send", text: "jalankan echo" });
      const card = await waitFor(() => permissionItems().find((p) => p.state === "pending" && p.command === command), "card for an ordinary command");
      ok(!card.dangerReason, "not flagged as dangerous");
      ok(card.actions.includes("allow_always_ws"), "always-allow offered");
      await svc.handleViewMessage({ type: "permission", id: card.id, action: "allow_always_ws" });
      await sending;
      ok(existsSync(marker), "command ran after approval");

      await script([{ toolCalls: [{ name: "terminal", arguments: { command } }] }, { text: "Lagi." }]);
      await svc.handleViewMessage({ type: "send", text: "lagi" });
      const again = permissionItems().at(-1)!;
      equal([again.command, again.state], [command, "allowed"], "second run auto-allowed");
      ok(again.resolution?.includes("automatically"), `resolution: ${again.resolution}`);
    }],

    ["F-12: @file and selection context reach the model", async () => {
      const file = path.join(ws, "src", "ctx.ts");
      writeFileSync(file, "export const MARKER_CTX = 42;\n");
      await script([{ text: "Sudah dibaca." }]);
      await svc.handleViewMessage({
        type: "send",
        text: "jelaskan",
        context: [
          { kind: "file", path: file },
          { kind: "selection", path: file, startLine: 1, endLine: 1, text: "SELECTION_MARKER" },
        ],
      });
      const users = JSON.stringify((await agentRequests()).at(-1).messages.filter((m: any) => m.role === "user"));
      ok(users.includes("MARKER_CTX = 42"), "file content sent");
      ok(users.includes("SELECTION_MARKER"), "selection sent");
      const user = items().filter((i) => i.kind === "user").at(-1) as Extract<TranscriptItem, { kind: "user" }>;
      equal(user.context?.map((c) => c.label), ["src/ctx.ts", "ctx.ts · 1"], "chips on the user bubble");
    }],

    ["F-13: inline edit proposes a diff in place and applies it, outside the chat", async () => {
      const file = path.join(ws, "src", "inline.ts");
      writeFileSync(file, "export function add(a, b) {\n  return a + b;\n}\n");
      await script([
        { toolCalls: [{ name: "patch", arguments: { mode: "replace", path: file, old_string: "return a + b;", new_string: "return Number(a) + Number(b);" } }] },
        { text: "Diubah ke Number." },
      ]);
      const chatItemsBefore = items().length;
      const source = new vscode.CancellationTokenSource();
      const editing = svc.inlineEdit(
        { path: file, startLine: 2, endLine: 2, text: "  return a + b;", languageId: "typescript", instruction: "cast to numbers" },
        source.token,
      );
      await nextReview();
      await decideReview(true);
      const reply = await editing;
      ok(reply.includes("Diubah ke Number."), `reply: ${reply}`);
      ok(lnf(readFileSync(file, "utf8")).includes("return Number(a) + Number(b);"), "file edited");
      ok(!items().slice(chatItemsBefore).some((i) => i.kind === "agent"), "inline reply kept out of the chat");
    }],

    ["F-14: sessions are listed, resumed with their history, and deleted", async () => {
      await script([{ text: "Jawaban sesi A." }]);
      await svc.handleViewMessage({ type: "send", text: "pesan-sesi-A" });
      const a = svc.state.sessionId!;
      await svc.newSession();
      ok(svc.state.sessionId && svc.state.sessionId !== a, "new session");
      equal(items().length, 0, "fresh transcript");
      ok((await svc.listSessions()).some((s) => s.id === a), "old session listed");
      await svc.openSession(a);
      equal(svc.state.sessionId, a, "resumed");
      await waitFor(() => items().some((i) => i.kind === "user" && i.text.includes("pesan-sesi-A")), "history replayed");
      ok(items().some((i) => i.kind === "agent" && i.text.includes("Jawaban sesi A.")), "agent reply replayed");
      await svc.newSession();
      await svc.deleteSession(a);
      ok(!(await svc.listSessions()).some((s) => s.id === a), "deleted session gone");
    }],

    ["F-15: MCP servers configured in the panel reach Hermes", async () => {
      await svc.handleViewMessage({
        type: "saveMcpServers",
        servers: [{ name: "ideecho", type: "stdio", command: process.env.HERMES_IT_NODE!, args: [process.env.HERMES_IT_ECHO!], enabled: true }],
      });
      await waitFor(() => svc.state.phase === "ready", "ready after applying MCP", 90_000);
      equal(svc.state.mcpServers.map((s) => s.name), ["ideecho"], "saved");
      let echoed = false;
      for (let attempt = 0; attempt < 10 && !echoed; attempt++) {
        await script([
          { toolCalls: [{ name: "tool_call", arguments: { calls: [{ name: "mcp__ideecho__echo", arguments: { text: "dari-ui" } }] } }] },
          { text: "ok" },
        ]);
        await svc.handleViewMessage({ type: "send", text: "echo" });
        echoed = JSON.stringify((await agentRequests()).at(-1).messages).includes("echo: dari-ui");
        if (!echoed) await sleep(1000);
      }
      if (!echoed) {
        const msgs = (await agentRequests()).at(-1).messages;
        const toolMsgs = msgs.filter((m: any) => m.role === "tool").slice(-2).map((m: any) => String(m.content).slice(0, 300));
        const tools = (await agentRequests()).at(-1).tools.map((t: any) => t.function.name).join(",");
        throw new Error(`MCP tool result missing; tool msgs=${JSON.stringify(toolMsgs)} tools=${tools.slice(-40)} phase=${svc.state.phase} busy=${svc.state.busy} last items=${JSON.stringify(items().slice(-3)).slice(0, 600)}`);
      }
      await svc.handleViewMessage({ type: "saveMcpServers", servers: [] });
      await waitFor(() => svc.state.phase === "ready", "ready after removing MCP", 90_000);
    }],

    ["F-16: endpoint profiles can be added and switched quickly", async () => {
      ok(svc.state.endpoint.profiles.some((p) => p.id === "custom-api"), "Phase 1 endpoint migrated to a profile");
      await svc.handleViewMessage({
        type: "saveProfile",
        profile: { name: "Second", baseUrl: MOCK, model: "mock-model-2", contextLength: 128000 },
      });
      await waitFor(() => svc.state.phase === "ready" && svc.state.currentModelId?.includes("mock-model-2"), "second profile active", 90_000);
      equal(svc.state.endpoint.activeProfileId, "second", "active profile");
      await svc.selectProfile("custom-api");
      await waitFor(() => svc.state.phase === "ready" && svc.state.currentModelId?.endsWith("mock-model"), "back to the first profile", 90_000);
    }],

    // ---- Phase 3 ------------------------------------------------------------------------

    ["F-17: Tab suggestions come from the FIM endpoint in under 500 ms and can be accepted", async () => {
      await svc.handleViewMessage({ type: "saveCompletion", enabled: true, baseUrl: MOCK, model: "qwen2.5-coder:1.5b", template: "auto" });
      await waitFor(() => api.completion.enabled && !!api.completion.endpoint(), "completion configured");
      const file = path.join(ws, "src", "fim.ts");
      writeFileSync(file, "export function add(a: number, b: number) {\n  return \n}\n");
      const doc = await vscode.workspace.openTextDocument(file);
      const editor = await vscode.window.showTextDocument(doc);
      const pos = new vscode.Position(1, 9);
      editor.selection = new vscode.Selection(pos, pos);

      await fim([{ text: "a + b;<|endoftext|>" }]);
      const source = new vscode.CancellationTokenSource();
      const t0 = Date.now();
      const items = await api.completion.provideInlineCompletionItems(
        doc, pos, { triggerKind: vscode.InlineCompletionTriggerKind.Invoke, selectedCompletionInfo: undefined }, source.token,
      );
      const ms = Date.now() - t0;
      equal(items.map((i) => i.insertText), ["a + b;"], "suggestion");
      ok(ms < 500, `suggestion took ${ms} ms`);
      const body = (await requestsTo("/v1/completions")).at(-1);
      ok(String(body.prompt).startsWith("<|fim_prefix|>export function add"), "Qwen FIM prompt");

      // Through the editor, as a user would: trigger, then accept like Tab does.
      await vscode.commands.executeCommand("editor.action.inlineSuggest.trigger");
      await sleep(800);
      await vscode.commands.executeCommand("editor.action.inlineSuggest.commit");
      await waitFor(() => doc.getText().includes("return a + b;"), "suggestion inserted", 5000);
      await vscode.commands.executeCommand("workbench.action.files.revert");
      await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
      console.log(`    (F-17 provider latency with an instant model: ${ms} ms)`);
    }],

    ["F-18: the codebase index embeds the workspace, answers @codebase and serves codebase_search to Hermes", async () => {
      writeFileSync(path.join(ws, "src", "auth.ts"), "export function login(user: string, password: string) {\n  return checkPassword(user, password);\n}\n");
      writeFileSync(path.join(ws, "src", "math.ts"), "export function multiply(x: number, y: number) {\n  return x * y;\n}\n");
      await svc.handleViewMessage({ type: "saveIndex", enabled: true, baseUrl: MOCK, model: "mock-embed" });
      await waitFor(() => svc.state.index.status === "ready", `index ready (status ${svc.state.index.status} ${svc.state.index.error ?? ""})`, 60_000);
      await waitFor(() => svc.state.phase === "ready", "Hermes ready again (IDE MCP attached)", 90_000);
      ok(svc.state.index.files >= 2, `indexed files: ${svc.state.index.files}`);

      const hits = await api.index.search("login user password", 3);
      equal(hits[0]?.path, "src/auth.ts", "semantic search finds auth.ts");

      await script([{ text: "Ketemu." }]);
      await svc.handleViewMessage({ type: "send", text: "where is the login password check", context: [{ kind: "codebase", path: "" }] });
      const users = JSON.stringify((await agentRequests()).at(-1).messages.filter((m: any) => m.role === "user"));
      ok(users.includes("checkPassword(user, password)"), "@codebase attached the matching chunk");

      let served = false;
      for (let attempt = 0; attempt < 10 && !served; attempt++) {
        await script([
          { toolCalls: [{ name: "tool_call", arguments: { calls: [{ name: "mcp__hermes_ide__codebase_search", arguments: { query: "login password" } }] } }] },
          { text: "ok" },
        ]);
        await svc.handleViewMessage({ type: "send", text: "cari login" });
        served = JSON.stringify((await agentRequests()).at(-1).messages).includes("src/auth.ts:1-");
        if (!served) await sleep(1000);
      }
      ok(served, "Hermes called codebase_search on the IDE MCP server");

      // Incremental: a new file is picked up without a rebuild, and only it is embedded.
      const before = (await requestsTo("/v1/embeddings")).length;
      const filesBefore = svc.state.index.files;
      writeFileSync(path.join(ws, "src", "session.ts"), "export function logout(sessionToken: string) {\n  revokeToken(sessionToken);\n}\n");
      await waitFor(() => svc.state.index.files > filesBefore && svc.state.index.status === "ready", `new file indexed (files ${svc.state.index.files})`, 30_000);
      const embeddedInputs = (await requestsTo("/v1/embeddings")).slice(before).flatMap((b) => b.input);
      ok(embeddedInputs.length > 0 && embeddedInputs.every((i: string) => i.includes("session.ts")), `only the new file re-embedded: ${JSON.stringify(embeddedInputs).slice(0, 200)}`);
      const embeddedSoFar = (await requestsTo("/v1/embeddings")).length;
      await api.index.reconfigure();
      await waitFor(() => svc.state.index.status === "ready", "index reloaded from disk", 30_000);
      await sleep(500);
      equal((await requestsTo("/v1/embeddings")).length, embeddedSoFar, "reloaded index needs no re-embedding");
      const top = await api.index.search("logout sessionToken revokeToken", 3);
      equal(top[0]?.path, "src/session.ts", `new file searchable; top=${JSON.stringify(top.map((h) => [h.path, h.score.toFixed(3), h.text.slice(0, 40)]))}`);
    }],

    ["the IDE updater is inert in plain VS Code and, as the standalone IDE, downloads, verifies and hands over to the installer (phase 4)", async () => {
      ok(!api.updater.standalone, "plain VS Code must not look like the standalone IDE");
      ok((await vscode.commands.getCommands(true)).includes("hermes.update.check"), "update command registered");

      const payload = Buffer.from("MZ pretend installer ".repeat(2000));
      const sha256 = createHash("sha256").update(payload).digest("hex");
      let feedVersion = "0.5.0";
      const server = createServer((req, res) => {
        if (req.url === "/latest.json") {
          res.end(JSON.stringify({
            schema: 1, version: feedVersion, releasedAt: "", notes: "",
            installers: { "win32-x64": { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/setup.exe`, sha256, size: payload.length } },
          }));
        } else res.end(payload);
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const feedUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/latest.json`;

      const shown: string[] = [];
      let pick: RegExp = /Update/;
      const win = vscode.window as unknown as Record<string, unknown>;
      const original = { info: win.showInformationMessage, warn: win.showWarningMessage };
      win.showInformationMessage = async (message: string, ...buttons: string[]) => {
        shown.push(message);
        return buttons.find((b) => typeof b === "string" && pick.test(b));
      };
      // Unsaved files from earlier tests would raise a modal "save first" prompt; accept it.
      win.showWarningMessage = async (_message: string, ...rest: unknown[]) => rest.filter((r) => typeof r === "string").at(-1);

      const store = new Map<string, unknown>();
      const context = { globalState: { get: (k: string) => store.get(k), update: async (k: string, v: unknown) => void store.set(k, v) } } as unknown as vscode.ExtensionContext;
      let launched: { file: string; args: string[] } | undefined;
      let quit = false;
      const updater = new IdeUpdater(context, { info: () => {} } as unknown as AgentLog, () => "en", {
        info: { version: "0.4.0", arch: "x64", updateFeedUrl: feedUrl },
        launchInstaller: async (file, args) => void (launched = { file, args }),
        quit: async () => void (quit = true),
        downloadDir: mkdtempSync(path.join(tmpdir(), "hermes-update-it-")),
      });
      try {
        ok(updater.standalone, "info override makes the updater standalone");
        equal((await updater.checkNow(true))?.version, "0.5.0", "newer release found");
        const handover = await waitFor(() => launched, "installer launched");
        ok(readFileSync(handover.file).equals(payload), "downloaded installer is byte-identical");
        ok(handover.args.includes("/VERYSILENT") && handover.args.includes("/UPDATE=1"), `installer args ${handover.args}`);
        await waitFor(() => quit, "IDE asked to quit after the hand-over");
        ok(shown[0]?.includes("0.5.0"), `prompt mentions the new version: ${shown[0]}`);

        feedVersion = "0.4.0";
        shown.length = 0;
        equal(await updater.checkNow(true), undefined, "no update when current");
        ok(shown.some((m) => m.includes("up to date")), `up-to-date notice: ${shown}`);

        feedVersion = "0.6.0";
        pick = /Skip/;
        await updater.checkNow(true);
        await waitFor(() => store.get("hermes.update.skippedVersion") === "0.6.0", "skipped version remembered");
        shown.length = 0;
        await updater.checkNow(false);
        await sleep(300);
        equal(shown.length, 0, "a skipped version is not announced again by background checks");
      } finally {
        Object.assign(win, { showInformationMessage: original.info, showWarningMessage: original.warn });
        server.close();
        updater.dispose();
      }
    }],

    // ---- Phase 5 ------------------------------------------------------------------------

    ["phase 5 rules: .hermes/rules.md reaches the model once per change, with a visible chip and a clean bubble", async () => {
      const dir = path.join(ws, ".hermes");
      const rulesFile = path.join(dir, "rules.md");
      mkdirSync(dir, { recursive: true });
      writeFileSync(rulesFile, "Always answer like a pirate. RULE_MARKER_ONE\n");
      await waitFor(() => svc.state.rules?.files.includes(".hermes/rules.md"), "rules detected by the watcher");
      await svc.handleViewMessage({ type: "newSession" }); // a fresh session, so the rules count as new
      const rulesBlocks = async () => {
        const users = JSON.stringify((await agentRequests()).at(-1).messages.filter((m: any) => m.role === "user"));
        return { users, count: users.split("<project-rules").length - 1 };
      };

      await script([{ text: "Arr." }]);
      await svc.handleViewMessage({ type: "send", text: "halo rules" });
      let seen = await rulesBlocks();
      ok(seen.users.includes("RULE_MARKER_ONE"), "rules sent with the first prompt");
      const first = items().filter((i) => i.kind === "user").at(-1) as Extract<TranscriptItem, { kind: "user" }>;
      ok(first.context?.some((c) => c.kind === "rules" && c.label === ".hermes/rules.md"), "rules chip on the user message");
      equal(first.text, "halo rules", "the bubble shows only what the user typed");

      await script([{ text: "Arr lagi." }]);
      await svc.handleViewMessage({ type: "send", text: "lagi" });
      equal((await rulesBlocks()).count, 1, "unchanged rules are not sent again");

      writeFileSync(rulesFile, "Now speak like a robot. RULE_MARKER_TWO\n");
      await sleep(600); // let the watcher notice; the prompt reads the file fresh anyway
      await script([{ text: "Beep." }]);
      await svc.handleViewMessage({ type: "send", text: "ketiga" });
      seen = await rulesBlocks();
      equal(seen.count, 2, "changed rules are sent again");
      ok(seen.users.includes("RULE_MARKER_TWO"), "new rules text");

      rmSync(rulesFile);
      await script([{ text: "Oke." }]);
      await svc.handleViewMessage({ type: "send", text: "keempat" });
      ok((await rulesBlocks()).users.includes("no longer apply"), "removal is announced");
      rmSync(dir, { recursive: true, force: true });
      await waitFor(() => !svc.state.rules, "rules cleared from the view state");
    }],

    ["phase 5 usage: Hermes' token counts are recorded per session and priced only from the user's own prices", async () => {
      await svc.handleViewMessage({ type: "newSession" });
      equal(svc.state.sessionUsage, undefined, "no usage in a new session");
      await script([{ text: "Satu." }]);
      await svc.handleViewMessage({ type: "send", text: "hitung 1" });
      const one = svc.state.sessionUsage;
      ok(one && one.turns === 1 && one.input > 0 && one.output > 0, "usage after one turn: " + JSON.stringify(one));
      equal(one!.cost, undefined, "no price configured, so no cost is guessed");

      await vscode.workspace.getConfiguration("hermes").update("pricing", { "mock-model": { input: 1000, output: 2000 } }, vscode.ConfigurationTarget.Global);
      await waitFor(() => svc.state.sessionUsage?.cost !== undefined, "cost appears once a price exists");
      const priced = svc.state.sessionUsage!;
      ok(Math.abs(priced.cost! - (priced.input * 1000 + priced.output * 2000) / 1e6) < 1e-9, "cost = tokens x price: " + JSON.stringify(priced));

      await script([{ text: "Dua." }]);
      await svc.handleViewMessage({ type: "send", text: "hitung 2" });
      ok(svc.state.sessionUsage!.turns === 2 && svc.state.sessionUsage!.input > priced.input, "second turn adds up");

      await svc.showUsage();
      const report = vscode.window.activeTextEditor?.document.getText() ?? "";
      ok(report.includes("Token and cost usage") && report.includes("mock-model"), "report document opened: " + report.slice(0, 200));
      await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
      await vscode.workspace.getConfiguration("hermes").update("pricing", undefined, vscode.ConfigurationTarget.Global);
    }],

    ["phase 5 checkpoints: 'Restore to here' puts agent edits back (reviewed and automatic), and can be undone", async () => {
      await svc.handleViewMessage({ type: "newSession" });
      const win = vscode.window as unknown as Record<string, unknown>;
      const original = { warn: win.showWarningMessage, info: win.showInformationMessage };
      win.showWarningMessage = async (_m: string, ...rest: unknown[]) => rest.filter((r) => typeof r === "string").at(-1);
      win.showInformationMessage = async () => undefined;
      const lastUser = () => items().filter((i) => i.kind === "user").at(-1) as Extract<TranscriptItem, { kind: "user" }>;
      const f = path.join(ws, "cp.txt");
      const g = path.join(ws, "cp-new.txt");
      rmSync(g, { force: true });
      try {
        writeFileSync(f, "ORIGINAL\n");
        // Hermes will not overwrite a file the agent has not read, so read it first like a real model.
        await script([
          { toolCalls: [{ name: "read_file", arguments: { path: f } }] },
          { toolCalls: [{ name: "write_file", arguments: { path: f, content: "CHANGED\n" } }] },
          { toolCalls: [{ name: "write_file", arguments: { path: g, content: "BRAND NEW\n" } }] },
          { text: "Selesai." },
        ]);
        const sending = svc.handleViewMessage({ type: "send", text: "ubah cp" });
        for (let i = 0; i < 2; i++) {
          await nextReview();
          await decideReview(true);
        }
        await sending;
        equal(lnf(readFileSync(f, "utf8")), "CHANGED\n", "agent edit applied");
        ok(existsSync(g), "agent created a file");
        await waitFor(() => lastUser().restorable === true, "the message offers a restore");

        await svc.restoreCheckpoint(lastUser().turn!);
        equal(lnf(readFileSync(f, "utf8")), "ORIGINAL\n", "edited file restored");
        ok(!existsSync(g), "created file removed");
        equal(svc.state.canUndoRestore, true, "restore can be undone");
        equal(lastUser().restorable, false, "nothing left to restore");

        await script([{ text: "Dipahami." }]);
        await svc.handleViewMessage({ type: "send", text: "lanjut" });
        const users = JSON.stringify((await agentRequests()).at(-1).messages.filter((m: any) => m.role === "user"));
        ok(users.includes("restored these files"), "the agent is told about the restore");

        await svc.undoRestore();
        equal(lnf(readFileSync(f, "utf8")), "CHANGED\n", "undo brings the agent's version back");
        ok(existsSync(g), "undo brings the created file back");

        // The automatic path (edit mode) must snapshot too.
        await svc.handleViewMessage({ type: "setMode", mode: "acceptEdits" });
        await script([
          { toolCalls: [{ name: "read_file", arguments: { path: f } }] },
          { toolCalls: [{ name: "write_file", arguments: { path: f, content: "AUTO\n" } }] },
          { text: "Otomatis." },
        ]);
        await svc.handleViewMessage({ type: "send", text: "ubah otomatis" });
        equal(lnf(readFileSync(f, "utf8")), "AUTO\n", "automatic edit applied");
        await waitFor(() => lastUser().restorable === true, "automatic edit is restorable");
        await svc.restoreCheckpoint(lastUser().turn!);
        equal(lnf(readFileSync(f, "utf8")), "CHANGED\n", "automatic edit restored to what it was before");
      } finally {
        await svc.handleViewMessage({ type: "setMode", mode: "manual" });
        Object.assign(win, { showWarningMessage: original.warn, showInformationMessage: original.info });
        rmSync(f, { force: true });
        rmSync(g, { force: true });
      }
    }],

    ["phase 5 checkpoints: a turn that ran a terminal command is flagged, since a restore cannot undo commands", async () => {
      await svc.handleViewMessage({ type: "newSession" });
      const marker = path.join(ws, "flag.txt").replace(/\\/g, "/");
      const command = `echo flagged > "${marker}"`;
      await script([{ toolCalls: [{ name: "terminal", arguments: { command } }] }, { text: "Selesai." }]);
      const sending = svc.handleViewMessage({ type: "send", text: "jalankan flag" });
      const card = await waitFor(() => permissionItems().find((p) => p.state === "pending" && p.command === command), "command card");
      await svc.handleViewMessage({ type: "permission", id: card.id, action: "allow_once" });
      await sending;
      const user = items().filter((i) => i.kind === "user").at(-1) as Extract<TranscriptItem, { kind: "user" }>;
      equal(user.ranCommands, true, "the turn is marked as having run commands");
      rmSync(marker, { force: true });
    }],

    ["phase 5 notifications: a finished turn and a permission request notify when switched on", async () => {
      const cfg = vscode.workspace.getConfiguration("hermes.notifications");
      const target = vscode.ConfigurationTarget.Global;
      await cfg.update("mode", "always", target);
      await cfg.update("minSeconds", 0, target);
      await cfg.update("native", false, target);
      const win = vscode.window as unknown as Record<string, unknown>;
      const original = win.showInformationMessage;
      const shown: string[] = [];
      win.showInformationMessage = async (message: string) => {
        shown.push(message);
        return undefined;
      };
      try {
        await svc.handleViewMessage({ type: "newSession" });
        await script([{ text: "Beres." }]);
        await svc.handleViewMessage({ type: "send", text: "kabari saya" });
        ok(shown.some((m) => m.startsWith("Hermes is done")), "done notification: " + JSON.stringify(shown));

        shown.length = 0;
        const victim = path.join(ws, "notify-victim");
        mkdirSync(victim, { recursive: true });
        const command = `rm -rf "${victim.replace(/\\/g, "/")}"`;
        await script([{ toolCalls: [{ name: "terminal", arguments: { command } }] }, { text: "Batal." }]);
        const sending = svc.handleViewMessage({ type: "send", text: "hapus notify-victim" });
        const card = await waitFor(() => permissionItems().find((p) => p.state === "pending" && p.command === command), "permission card");
        ok(shown.some((m) => m.startsWith("Hermes needs your permission")), "permission notification: " + JSON.stringify(shown));
        await svc.handleViewMessage({ type: "permission", id: card.id, action: "reject" });
        await sending;

        await cfg.update("mode", "off", target);
        shown.length = 0;
        await script([{ text: "Diam." }]);
        await svc.handleViewMessage({ type: "send", text: "tanpa notifikasi" });
        equal(shown.filter((m) => m.startsWith("Hermes is done")).length, 0, "no notification when switched off");
      } finally {
        win.showInformationMessage = original;
        for (const key of ["mode", "minSeconds", "native"]) await cfg.update(key, undefined, target);
        rmSync(path.join(ws, "notify-victim"), { recursive: true, force: true });
      }
    }],

    ["phase 5 Hermes update: asks first, backs up, stops Hermes during the update, restarts it, and judges the version", async () => {
      if (process.platform !== "win32") return;
      const dir = mkdtempSync(path.join(tmpdir(), "hermes-maint-it-"));
      writeFileSync(path.join(dir, "fake.js"), String.raw`
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_OUT, args.join(" ") + "\n");
if (args[0] === "update" && args[1] === "--check") { console.log("Update available: 5 commits behind origin/main."); process.exit(0); }
if (args[0] === "update") { console.log("updating"); process.exit(Number(process.env.FAKE_EXIT || 0)); }
process.exit(2);
`);
      const fake = path.join(dir, "fake-hermes.cmd");
      writeFileSync(fake, "@echo off\r\nnode \"%~dp0fake.js\" %*\r\n");
      const record = path.join(dir, "calls.txt");

      const calls: string[] = [];
      const notices: string[] = [];
      let version = "0.21.4";
      let exitCode = "0";
      const host: MaintenanceHost = {
        locale: () => "en",
        hermesPath: () => fake,
        env: () => ({ ...process.env, FAKE_OUT: record, FAKE_EXIT: exitCode }),
        version: () => version,
        busy: () => false,
        stopHermes: async () => void calls.push("stop"),
        refresh: async () => void calls.push("refresh"),
        setUpdateStatus: (status) => void calls.push("status:" + status),
        notice: (_level, text) => void notices.push(text),
      };
      const store = new Map<string, unknown>();
      const context = { globalState: { get: (k: string) => store.get(k), update: async (k: string, v: unknown) => void store.set(k, v) } } as unknown as vscode.ExtensionContext;
      const maintenance = new HermesMaintenance(context, { info: () => {}, hermes: () => {} } as unknown as AgentLog, host);

      const win = vscode.window as unknown as Record<string, unknown>;
      const original = { warn: win.showWarningMessage, info: win.showInformationMessage };
      let answer: string | undefined;
      win.showWarningMessage = async (_m: string, ...rest: unknown[]) => (answer === "confirm" ? rest.filter((r) => typeof r === "string").at(-1) : undefined);
      win.showInformationMessage = async () => undefined;
      try {
        answer = undefined; // the user declines
        await maintenance.update();
        equal(calls, [], "declining runs nothing");
        ok(!existsSync(record), "Hermes was not called");

        answer = "confirm";
        version = "0.21.4";
        await maintenance.update();
        equal(calls, ["status:updating", "stop", "refresh", "status:current"], "stop before, refresh after");
        ok(readFileSync(record, "utf8").includes("update --backup --yes"), "full backup and no prompts");
        ok(notices.at(-1)?.includes("updated to 0.21.4"), "inside the tested range: " + notices.at(-1));

        calls.length = 0;
        version = "0.23.0"; // what the version check finds after the update
        await maintenance.update();
        ok(notices.at(-1)?.includes("outside the tested versions"), "newer than tested is called out: " + notices.at(-1));

        calls.length = 0;
        exitCode = "1";
        await maintenance.update();
        ok(notices.at(-1)?.includes("failed"), "failure reported: " + notices.at(-1));
        equal(calls.at(-1), "status:unknown", "status after a failed update");
        ok(calls.includes("refresh"), "Hermes is restarted even after a failed update");

        calls.length = 0;
        await maintenance.checkUpdate(false);
        equal(calls, ["status:checking", "status:available"], "background check only reports");
      } finally {
        Object.assign(win, { showWarningMessage: original.warn, showInformationMessage: original.info });
        maintenance.dispose();
        rmSync(dir, { recursive: true, force: true });
      }
    }],

    // ---- Phase 6 ------------------------------------------------------------------------

    ["phase 6 local mode: network tools are blocked by the hook, network commands always ask, and a local endpoint keeps working", async () => {
      const cfg = vscode.workspace.getConfiguration("hermes.privacy");
      const target = vscode.ConfigurationTarget.Global;
      try {
        await cfg.update("localOnly", true, target);
        await waitFor(() => svc.state.privacy?.localOnly === true, "local mode published");
        await waitFor(() => svc.state.phase === "ready", "Hermes back after the restart for the new hook flags", 90_000);
        equal(svc.state.privacy?.blocked, undefined, "a loopback endpoint is allowed");
        equal(svc.state.terminalApproval, "active", "the hook is installed");

        // 1. a network tool never runs: the hook answers for it and the model is told why.
        await script([{ toolCalls: [{ name: "web_search", arguments: { query: "pirate speak" } }] }, { text: "Tanpa web." }]);
        await svc.handleViewMessage({ type: "send", text: "cari di web" });
        ok((await agentRequests()).length > 0, "the model was reached: phase=" + svc.state.phase + " " + JSON.stringify(items().slice(-4)).slice(0, 600));
        // The session keeps earlier tool results, so only the newest one is about this call.
        const lastTool = String((await agentRequests()).at(-1).messages.filter((m: any) => m.role === "tool").at(-1)?.content);
        ok(lastTool.includes("Full local mode is on"), "the blocked tool call came back with the reason: " + lastTool.slice(0, 400));
        ok(!items().some((i) => i.kind === "tool" && i.status === "completed"), "the blocked call never ran: " + JSON.stringify(items().slice(-4)).slice(0, 500));

        // 2. a command that reaches the internet asks, even in a mode that would normally run it, and cannot be always-allowed.
        await svc.handleViewMessage({ type: "setMode", mode: "auto" });
        const command = "curl https://example.com/health-" + Date.now();
        await script([{ toolCalls: [{ name: "terminal", arguments: { command } }] }, { text: "Ditolak." }]);
        const sending = svc.handleViewMessage({ type: "send", text: "cek example.com" });
        const card = await waitFor(() => permissionItems().find((p) => p.state === "pending" && p.command === command), "card for a network command even in auto mode");
        ok(card.dangerReason?.includes("Local mode"), "the card says why: " + card.dangerReason);
        ok(!card.actions.includes("allow_always_ws"), "no always-allow for a network command");
        await svc.handleViewMessage({ type: "permission", id: card.id, action: "reject" });
        await sending;
        await svc.handleViewMessage({ type: "setMode", mode: "manual" });

        // 3. an ordinary local command is untouched.
        const marker = path.join(ws, "local-ok.txt").replace(/\\/g, "/");
        const local = "echo ok > \"" + marker + "\"";
        await script([{ toolCalls: [{ name: "terminal", arguments: { command: local } }] }, { text: "Selesai." }]);
        const sending2 = svc.handleViewMessage({ type: "send", text: "tulis file lokal" });
        const localCard = await waitFor(() => permissionItems().find((p) => p.state === "pending" && p.command === local), "card for a local command");
        ok(!localCard.dangerReason, "a local command is not flagged: " + localCard.dangerReason);
        await svc.handleViewMessage({ type: "permission", id: localCard.id, action: "allow_once" });
        await sending2;
        ok(existsSync(marker), "the local command ran");
        rmSync(marker, { force: true });
      } finally {
        await svc.handleViewMessage({ type: "setMode", mode: "manual" });
        await cfg.update("localOnly", undefined, target);
        await waitFor(() => svc.state.privacy?.localOnly === false, "local mode off again");
        await waitFor(() => svc.state.phase === "ready", "Hermes back after local mode is off", 90_000);
      }
    }],

    ["phase 6 local mode: a remote endpoint keeps the agent from starting, and the way back works", async () => {
      const cfg = vscode.workspace.getConfiguration("hermes.privacy");
      const target = vscode.ConfigurationTarget.Global;
      const goodProfile = svc.state.endpoint.activeProfileId;
      let remoteId: string | undefined;
      try {
        await cfg.update("localOnly", true, target);
        await waitFor(() => svc.state.privacy?.localOnly === true, "local mode published");
        await svc.handleViewMessage({ type: "saveProfile", profile: { name: "Remote", baseUrl: "https://api.example.com/v1", model: "some-model", contextLength: 0 } });
        remoteId = svc.state.endpoint.activeProfileId;
        ok(remoteId !== goodProfile, "the remote profile is active");
        await waitFor(() => !!svc.state.privacy?.blocked, "the agent is held back");
        ok(svc.state.privacy!.blocked!.includes("api.example.com"), "the reason names the endpoint: " + svc.state.privacy!.blocked);
        equal(svc.processId, undefined, "Hermes was not started for a remote endpoint");
        const before = items().length;
        await svc.handleViewMessage({ type: "send", text: "ini tidak boleh terkirim" });
        ok(!items().slice(before).some((i) => i.kind === "user"), "the message was not even added to the chat");
        ok(items().some((i) => i.kind === "notice" && i.level === "error" && i.text.includes("Full local mode")), "the user is told why");

        // naming the server as one's own lifts the block
        await cfg.update("allowedHosts", ["api.example.com"], target);
        await waitFor(() => !svc.state.privacy?.blocked, "an allowed host unblocks");
        await cfg.update("allowedHosts", undefined, target);
        await waitFor(() => !!svc.state.privacy?.blocked, "and removing it blocks again");
      } finally {
        await svc.selectProfile(goodProfile);
        if (remoteId && remoteId !== goodProfile) await svc.handleViewMessage({ type: "deleteProfile", id: remoteId });
        await cfg.update("localOnly", undefined, target);
        await cfg.update("allowedHosts", undefined, target);
        await waitFor(() => svc.state.privacy?.localOnly === false, "local mode off again");
        await waitFor(() => svc.state.phase === "ready", "Hermes ready on the original profile", 90_000);
      }
    }],

    ["phase 6 local mode: Tab completion and the index are switched off for remote endpoints, and the privacy check says so", async () => {
      const completion = vscode.workspace.getConfiguration("hermes.completion");
      const privacy = vscode.workspace.getConfiguration("hermes.privacy");
      const target = vscode.ConfigurationTarget.Global;
      try {
        await completion.update("enabled", true, target);
        await completion.update("baseUrl", "https://fim.example.com/v1", target);
        await completion.update("model", "some-fim", target);
        equal(api.completion.endpoint()?.baseUrl, "https://fim.example.com/v1", "without local mode a remote FIM endpoint is used");
        await privacy.update("localOnly", true, target);
        await waitFor(() => api.completion.endpoint() === undefined, "completion endpoint withheld");
        equal(api.completion.view().blocked, true, "the view says why");

        await vscode.commands.executeCommand("hermes.privacy.report");
        const report = vscode.window.activeTextEditor?.document.getText() ?? "";
        ok(report.includes("Privacy check") && report.includes("Tab autocomplete") && report.includes("fim.example.com"), "report lists the remote completion endpoint: " + report.slice(0, 300));
        ok(report.includes("Honest limits"), "report states what it cannot guard");
        await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
      } finally {
        await privacy.update("localOnly", undefined, target);
        for (const key of ["enabled", "baseUrl", "model"]) await completion.update(key, undefined, target);
        await waitFor(() => svc.state.privacy?.localOnly === false && svc.state.phase === "ready", "back to normal", 90_000);
      }
    }],

    ["phase 6 routing: short questions go to the light model, heavy work to the strong one, a failing model falls back, and a manual pick pauses it", async () => {
      const cfg = vscode.workspace.getConfiguration("hermes.routing");
      const target = vscode.ConfigurationTarget.Global;
      // Hermes lists only the profile's own model; the others the endpoint serves come from its /models.
      const light = (await waitFor(() => svc.state.models.find((m) => m.id.includes("mock-model-2")), "the endpoint's second model in the picker")).id;
      const strong = svc.state.models.find((m) => m.id.endsWith(":mock-model"))?.id;
      ok(strong, "the first model is offered: " + JSON.stringify(svc.state.models.map((m) => m.id)));
      const sentModel = async () => String((await agentRequests()).at(-1).model);
      const notices = () => items().filter((i): i is Extract<TranscriptItem, { kind: "notice" }> => i.kind === "notice").map((i) => i.text);
      try {
        await svc.newSession();
        await svc.selectModel(strong!);
        await cfg.update("lightModel", light, target);
        await cfg.update("heavyModel", strong, target);
        await cfg.update("fallbackModel", strong, target);
        await cfg.update("enabled", true, target);
        await waitFor(() => svc.state.routing?.enabled === true, "routing published");

        // 1. a short question goes to the light model, and the chat says so
        await script([{ text: "Closure itu fungsi plus lingkungannya." }]);
        await svc.handleViewMessage({ type: "send", text: "apa itu closure?" });
        equal(svc.state.currentModelId, light, "light model selected");
        equal(await sentModel(), "mock-model-2", "the request went to the light model");
        ok(notices().some((n) => n.startsWith("Routing:")), "the switch is written in the chat: " + JSON.stringify(notices()));

        // 2. heavy work goes back to the strong model
        await script([{ text: "Rencana refactor." }]);
        await svc.handleViewMessage({ type: "send", text: "tolong refactor seluruh modul auth" });
        equal(svc.state.currentModelId, strong, "strong model selected");
        equal(await sentModel(), "mock-model", "the request went to the strong model");

        // 3. the light model fails: the same message is retried once with the fallback and the user sees both
        await fetch(`${CONTROL}/__fail`, { method: "POST", body: JSON.stringify({ "mock-model-2": 401 }) });
        await script([{ text: "Jawaban dari cadangan." }]);
        await svc.handleViewMessage({ type: "send", text: "apa itu monad?" });
        ok(items().some((i) => i.kind === "agent" && i.text.includes("Jawaban dari cadangan.")), "the fallback answered: " + JSON.stringify(items().slice(-6)).slice(0, 700));
        ok(notices().some((n) => /trying again|mencoba lagi/.test(n)), "the failover is explained: " + JSON.stringify(notices()));
        equal(svc.state.currentModelId, strong, "the fallback is now the selected model");
        equal(items().filter((i) => i.kind === "user" && i.text === "apa itu monad?").length, 1, "the question is in the chat once");

        // 4. the failed model is not tried again right away
        await script([{ text: "Masih cadangan." }]);
        await svc.handleViewMessage({ type: "send", text: "apa itu tuple?" });
        equal(await sentModel(), "mock-model", "a model that just failed is skipped");
        await fetch(`${CONTROL}/__fail`, { method: "POST", body: JSON.stringify({ "mock-model-2": 0 }) });

        // 5. picking a model yourself pauses routing for the session
        await svc.handleViewMessage({ type: "selectModel", modelId: light! });
        ok(notices().some((n) => n.includes("paused") || n.includes("dijeda")), "the pause is announced");
        await script([{ text: "Tetap ringan." }]);
        await svc.handleViewMessage({ type: "send", text: "tolong refactor seluruh modul pembayaran" });
        equal(svc.state.currentModelId, light, "routing left the manual pick alone");
      } finally {
        await fetch(`${CONTROL}/__fail`, { method: "POST", body: JSON.stringify({ "mock-model-2": 0 }) });
        for (const key of ["enabled", "lightModel", "heavyModel", "fallbackModel"]) await cfg.update(key, undefined, target);
        await svc.newSession();
        if (strong) await svc.selectModel(strong);
      }
    }],

    ["phase 6 memory: the panel shows, edits and saves Hermes' memory in Hermes' own format, and a new session reads it", async () => {
      const got: any[] = [];
      const sub = svc.attachView((m) => got.push(m));
      const panelOf = () => [...got].reverse().find((m) => m.type === "memory")?.panel;
      const targetOf = (name: string) => panelOf().targets.find((t: any) => t.target === name);
      let memoryFile = "";
      try {
        await svc.handleViewMessage({ type: "loadMemory" });
        ok(panelOf(), "the host answered with the memory panel");
        memoryFile = path.join(panelOf().home, "memories", "MEMORY.md");
        mkdirSync(path.dirname(memoryFile), { recursive: true });
        rmSync(memoryFile + ".hermes-ide-bak", { force: true });

        // what Hermes wrote is shown as separate notes
        writeFileSync(memoryFile, "Proyek ini memakai pnpm.\n§\nJangan sentuh folder legacy.");
        await svc.handleViewMessage({ type: "loadMemory" });
        equal(targetOf("memory").entries, ["Proyek ini memakai pnpm.", "Jangan sentuh folder legacy."], "entries parsed");
        equal(targetOf("memory").limit, 2200, "Hermes' default budget");

        // an edit is saved exactly the way Hermes reads it back, keeping the old file
        const hash = targetOf("memory").hash;
        await svc.handleViewMessage({ type: "saveMemory", target: "memory", entries: ["Proyek ini memakai pnpm.", " Pengguna suka kopi tanpa gula. ", ""], hash });
        equal(panelOf().notice?.level, "ok", "saved: " + JSON.stringify(panelOf().notice));
        equal(readFileSync(memoryFile, "utf8"), "Proyek ini memakai pnpm.\n§\nPengguna suka kopi tanpa gula.", "file content");
        equal(readFileSync(memoryFile + ".hermes-ide-bak", "utf8"), "Proyek ini memakai pnpm.\n§\nJangan sentuh folder legacy.", "previous version kept");

        // a save based on an old read is refused (the agent may have saved something meanwhile)
        await svc.handleViewMessage({ type: "saveMemory", target: "memory", entries: ["terlambat"], hash });
        equal(panelOf().notice?.level, "error", "stale save refused");
        ok(readFileSync(memoryFile, "utf8").includes("kopi"), "file untouched by the stale save");

        // over the budget is refused
        await svc.handleViewMessage({ type: "saveMemory", target: "memory", entries: ["x".repeat(2300)], hash: targetOf("memory").hash });
        equal(panelOf().notice?.level, "error", "too long refused");

        // a session started afterwards reads the file: it is in the system prompt the model gets
        await svc.newSession();
        await script([{ text: "Baik." }]);
        await svc.handleViewMessage({ type: "send", text: "halo memori" });
        const system = JSON.stringify((await agentRequests()).at(-1).messages.find((m: any) => m.role === "system")?.content ?? "");
        ok(system.includes("kopi tanpa gula"), "the note reached the model's system prompt");
      } finally {
        sub.dispose();
        if (memoryFile) rmSync(memoryFile, { force: true });
        if (memoryFile) rmSync(memoryFile + ".hermes-ide-bak", { force: true });
      }
    }],

    ["phase 6 skills: the gallery lists what `hermes skills` reports, and searching is switched off in full local mode", async () => {
      const got: any[] = [];
      const sub = svc.attachView((m) => got.push(m));
      const skillsOf = () => [...got].reverse().find((m) => m.type === "skills")?.panel;
      const cfg = vscode.workspace.getConfiguration("hermes.privacy");
      let skillDir = "";
      try {
        await svc.handleViewMessage({ type: "loadMemory" }); // tells where the IDE's Hermes keeps its files
        const home = [...got].reverse().find((m) => m.type === "memory").panel.home as string;
        skillDir = path.join(home, "skills", "notes", "ide-test-skill");
        mkdirSync(skillDir, { recursive: true });
        writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: ide-test-skill\ndescription: A skill made by the test.\n---\n\n# Test\nSay hi.\n");

        await svc.handleViewMessage({ type: "loadSkills" });
        const listed = skillsOf();
        ok(listed && !listed.working, "the list came back");
        ok(listed.installed.some((s: any) => s.name === "ide-test-skill" && s.source === "local" && s.enabled), "the local skill is listed: " + JSON.stringify(listed).slice(0, 400));

        // a local skill is not the gallery's to remove
        await svc.handleViewMessage({ type: "uninstallSkill", name: "ide-test-skill" });
        equal(skillsOf().notice?.level, "error", "refused");
        ok(existsSync(path.join(skillDir, "SKILL.md")), "still there");

        // full local mode: nothing goes to the registries
        await cfg.update("localOnly", true, vscode.ConfigurationTarget.Global);
        await waitFor(() => svc.state.privacy?.localOnly === true, "local mode published");
        await svc.handleViewMessage({ type: "searchSkills", query: "git" });
        ok(skillsOf().blocked, "the panel says searching is off");
        equal(skillsOf().results, [], "no results came from the internet");
      } finally {
        sub.dispose();
        await cfg.update("localOnly", undefined, vscode.ConfigurationTarget.Global);
        if (skillDir) rmSync(skillDir, { recursive: true, force: true });
        await waitFor(() => svc.state.privacy?.localOnly === false && svc.state.phase === "ready", "back to normal", 90_000);
      }
    }],

    ["phase 6 parallel tasks: agents work in their own worktrees, commands are refused, the result is applied or discarded", async () => {
      const tm = svc.taskManager;
      tm.setConfirm(async () => true);
      const gitIn = (args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { cwd: ws, encoding: "utf8" });
      const created: string[] = [];
      const hadGit = existsSync(path.join(ws, ".git"));
      try {
        if (!hadGit) {
          gitIn(["init", "-q", "-b", "main"]);
          writeFileSync(path.join(ws, "base.txt"), "base\n");
          gitIn(["add", "-A"]);
          gitIn(["commit", "-q", "-m", "base"]);
        }
        const taskNamed = (marker: string) => tm.views().find((v) => v.title.includes(marker));
        const finished = (marker: string) => taskNamed(marker) && !["starting", "running"].includes(taskNamed(marker)!.status) ? taskNamed(marker) : undefined;

        // one agent: writes a file, then tries a command it is not allowed to run
        await script([
          { when: "[satu]", toolCalls: [{ name: "write_file", arguments: { path: "hasil-satu.txt", content: "dari agen satu\n" } }] },
          { when: "[satu]", toolCalls: [{ name: "terminal", arguments: { command: "echo halo > luar-satu.txt" } }] },
          { when: "[satu]", text: "Selesai: hasil-satu.txt dibuat." },
        ]);
        await svc.handleViewMessage({ type: "startTask", prompt: "[satu] buat hasil-satu.txt", allowCommands: false });
        const one = await waitFor(() => finished("[satu]"), "the first task to finish", 180_000);
        created.push("hasil-satu.txt");
        equal(one.status, "done", "task status (error: " + one.error + ")");
        equal(one.files, ["hasil-satu.txt"], "the files it changed");
        ok(one.summary?.includes("Selesai"), "its closing summary is kept: " + one.summary);
        equal(one.deniedCount, 1, "the command was refused");
        equal(one.denied[0].reason, "commandsOff", "and the panel can say why");

        const dir = tm.directoryOf(one.id)!;
        ok(existsSync(path.join(dir, "hasil-satu.txt")), "the file is in the task's worktree");
        ok(!existsSync(path.join(dir, "luar-satu.txt")), "the refused command did not run");
        ok(!existsSync(path.join(ws, "hasil-satu.txt")), "the project itself is untouched until the result is applied");
        ok(!existsSync(path.join(ws, "luar-satu.txt")), "the refused command did not run in the project either");

        // two agents at the same time, each with its own replies and its own files
        await script([
          { when: "[A]", delayMs: 2500, toolCalls: [{ name: "write_file", arguments: { path: "a.txt", content: "A\n" } }] },
          { when: "[A]", text: "A pronto" },
          { when: "[B]", delayMs: 2500, toolCalls: [{ name: "write_file", arguments: { path: "b.txt", content: "B\n" } }] },
          { when: "[B]", text: "B pronto" },
        ]);
        await svc.handleViewMessage({ type: "startTask", prompt: "[A] buat a.txt", allowCommands: false });
        await svc.handleViewMessage({ type: "startTask", prompt: "[B] buat b.txt", allowCommands: false });
        await waitFor(() => tm.views().filter((v) => v.status === "running").length === 2, "both agents running at the same time", 120_000);
        const [a, b] = await Promise.all([waitFor(() => finished("[A]"), "task A", 180_000), waitFor(() => finished("[B]"), "task B", 180_000)]);
        equal(a.files, ["a.txt"], "A changed only its own file");
        equal(b.files, ["b.txt"], "B changed only its own file");
        ok(!existsSync(path.join(tm.directoryOf(a.id)!, "b.txt")) && !existsSync(path.join(tm.directoryOf(b.id)!, "a.txt")), "they do not see each other's work");

        // review and apply the first result: it arrives as an uncommitted change in the project
        await svc.handleViewMessage({ type: "viewTaskChanges", id: one.id });
        ok(vscode.window.activeTextEditor?.document.getText().includes("hasil-satu.txt"), "the diff is shown");
        await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
        await svc.handleViewMessage({ type: "applyTask", id: one.id });
        equal(readFileSync(path.join(ws, "hasil-satu.txt"), "utf8").replace(/\r\n/g, "\n"), "dari agen satu\n", "the result is in the project");
        ok(taskNamed("[satu]")!.applied, "and marked as applied");

        // discard the others: worktree and branch are gone
        for (const task of [a, b, one]) {
          const folder = tm.directoryOf(task.id)!;
          await svc.handleViewMessage({ type: "discardTask", id: task.id });
          ok(!existsSync(folder), "worktree removed");
        }
        equal(tm.views().length, 0, "no tasks left");
        equal(gitIn(["branch", "--list", "hermes/task-*"]).trim(), "", "branches removed");
      } finally {
        tm.setConfirm(undefined);
        for (const f of created) rmSync(path.join(ws, f), { force: true });
        if (!hadGit) {
          // git marks its object files read-only, which Windows refuses to delete until the attribute is cleared
          if (process.platform === "win32") try { execFileSync("attrib", ["-r", path.join(ws, ".git", "*"), "/s", "/d"], { stdio: "pipe" }); } catch { /* best effort */ }
          rmSync(path.join(ws, ".git"), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        }
      }
    }],

    ["a crashed Hermes can be restarted without reloading, keeping the session (NFR reliability)", async () => {
      // Hermes only persists sessions that have been prompted, so give this one some history first.
      await script([{ text: "Sebelum crash." }]);
      await svc.handleViewMessage({ type: "send", text: "halo" });
      const sessionId = svc.state.sessionId;
      const pid = svc.processId!;
      // A grandchild (e.g. conhost) can refuse to die and make taskkill exit non-zero even though
      // Hermes itself is gone; the phase change below is what matters.
      try {
        execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "pipe" });
      } catch {
        // see above
      }
      await waitFor(() => svc.state.phase === "crashed", "phase crashed");
      await svc.handleViewMessage({ type: "restart" });
      await waitFor(() => svc.state.phase === "ready", "phase ready after restart", 90_000);
      equal(svc.state.sessionId, sessionId, "same session after restart");
      await script([{ text: "Masih tersambung." }]);
      await svc.handleViewMessage({ type: "send", text: "halo lagi" });
      ok(items().some((i) => i.kind === "agent" && i.text.includes("Masih tersambung.")), `reply after restart; phase=${svc.state.phase} last=${JSON.stringify(items().slice(-3)).slice(0, 600)}`);
    }],
  ];

  const failures: string[] = [];
  // HERMES_TEST_ONLY="phase 6,crashed": run the first two tests (they start the panel) and the ones whose name contains any part.
  const only = (process.env.HERMES_TEST_ONLY ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  for (const [index, [name, fn]] of tests.entries()) {
    if (only.length && index > 1 && !only.some((part) => name.includes(part))) continue;
    const t0 = Date.now();
    try {
      await fn();
      console.log(`  ✓ ${name} (${Date.now() - t0} ms)`);
    } catch (error) {
      console.log(`  ✗ ${name}\n      ${(error as Error).message}`);
      failures.push(name);
    }
  }
  await svc.shutdown();
  if (failures.length) throw new Error(`${failures.length} test(s) failed`);
}
