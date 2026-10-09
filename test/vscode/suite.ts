// Runs inside a real VS Code extension host (launched by runTest.mjs). Drives the extension the
// way the panel does, against the real `hermes acp` and the scripted OpenAI mock.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { HermesIdeApi } from "../../src/extension";
import type { TranscriptItem } from "../../src/shared/protocol";

const MOCK = process.env.HERMES_IT_MOCK_URL!;
const CONTROL = MOCK.replace(/\/v1$/, "");

async function script(replies: unknown[]): Promise<void> {
  await fetch(`${CONTROL}/__script`, { method: "POST", body: JSON.stringify(replies) });
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
  for (const [name, fn] of tests) {
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
