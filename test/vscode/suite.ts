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
