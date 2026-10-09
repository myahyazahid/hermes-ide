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

/** Waits for a new diff review editor and returns its review id. */
async function nextReview(): Promise<string> {
  return waitFor(() => {
    for (const ed of vscode.window.visibleTextEditors) {
      if (ed.document.uri.scheme !== "hermes-diff") continue;
      const id = ed.document.uri.path.split("/")[1];
      if (id && !seenReviews.has(id)) {
        seenReviews.add(id);
        return id;
      }
    }
    return undefined;
  }, "diff review editor");
}

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
        await vscode.commands.executeCommand("hermes.diff.accept");
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
      await vscode.commands.executeCommand("hermes.diff.reject");
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
      await vscode.commands.executeCommand("hermes.diff.accept");
      await sending;
      const expected = ["a", "B", "c", "d", "e", "f", "g"].join("\n") + "\n";
      await waitFor(() => lnf(readFileSync(d, "utf8")) === expected, "partial revert", 15_000).catch((e: Error) => {
        const notices = items().filter((i) => i.kind === "notice" || i.kind === "permission").slice(-3);
        throw new Error(`${e.message}; file=${JSON.stringify(readFileSync(d, "utf8"))}; recent=${JSON.stringify(notices)}`);
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

    ["a crashed Hermes can be restarted without reloading, keeping the session (NFR reliability)", async () => {
      const sessionId = svc.state.sessionId;
      const pid = svc.processId!;
      execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"]);
      await waitFor(() => svc.state.phase === "crashed", "phase crashed");
      await svc.handleViewMessage({ type: "restart" });
      await waitFor(() => svc.state.phase === "ready", "phase ready after restart", 90_000);
      equal(svc.state.sessionId, sessionId, "same session after restart");
      await script([{ text: "Masih tersambung." }]);
      await svc.handleViewMessage({ type: "send", text: "halo lagi" });
      ok(items().some((i) => i.kind === "agent" && i.text.includes("Masih tersambung.")), "reply after restart");
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
