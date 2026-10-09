import * as path from "node:path";
import * as vscode from "vscode";
import { McpHttpServer } from "./core/mcpHttpServer";
import { t } from "./shared/strings";
import { AgentLog } from "./vscode/agentLog";
import { ChatViewProvider } from "./vscode/chatView";
import { CodebaseIndex } from "./vscode/codebaseIndex";
import { DiffReviewManager } from "./vscode/diffReview";
import { HermesService } from "./vscode/hermesService";
import { runInlineEdit } from "./vscode/inlineEdit";
import { SessionsView, type SessionSummary } from "./vscode/sessionsView";
import { HermesStatusBar } from "./vscode/statusBar";
import { TabCompletion } from "./vscode/tabCompletion";

let service: HermesService | undefined;
let ideMcp: McpHttpServer | undefined;

/** Returned from activate() so the extension-host tests can drive the service directly. */
export interface HermesIdeApi {
  service: HermesService;
  reviews: DiffReviewManager;
  sessions: SessionsView;
  completion: TabCompletion;
  index: CodebaseIndex;
}

export function activate(context: vscode.ExtensionContext): HermesIdeApi {
  const log = new AgentLog();
  // The review manager is created first; its selection callback is wired once the service exists.
  let onSelection: (id: string, accepted: number, total: number) => void = () => {};
  const reviews = new DiffReviewManager(() => service?.locale ?? "en", (id, a, n) => onSelection(id, a, n));
  const root = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const completion = new TabCompletion(context.secrets);
  const index = new CodebaseIndex(context, log, root);
  ideMcp = new McpHttpServer(() => [index.mcpTool()], {
    name: "hermes-ide",
    version: String(context.extension.packageJSON.version ?? "0.0.0"),
  }, (line) => log.info(line));
  service = new HermesService(context, log, reviews, { completion, index, mcp: ideMcp });
  const svc = service;
  onSelection = (id, a, n) => svc.onReviewSelectionChanged(id, a, n);

  const statusBar = new HermesStatusBar(() => svc.locale);
  const chat = new ChatViewProvider(context.extensionUri, svc);
  const sessions = new SessionsView(svc);
  const sessionsTree = vscode.window.createTreeView(SessionsView.viewId, { treeDataProvider: sessions });
  const updateSessionsMessage = () => {
    sessionsTree.message = svc.state.phase === "ready" ? undefined : t(svc.locale, "sessions.openPanel");
  };

  context.subscriptions.push(
    log,
    reviews,
    completion,
    index,
    svc,
    statusBar,
    sessions,
    sessionsTree,
    svc.onDidChangeState((s) => {
      statusBar.update(s);
      updateSessionsMessage();
    }),
    svc.onDidChangeSessions(() => sessions.refresh()),
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, chat, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand("hermes.openChat", () => chat.reveal({ type: "focusComposer" })),
    vscode.commands.registerCommand("hermes.newSession", () => svc.newSession()),
    vscode.commands.registerCommand("hermes.stop", () => svc.stop()),
    vscode.commands.registerCommand("hermes.restart", () => svc.restart()),
    vscode.commands.registerCommand("hermes.configureEndpoint", () => chat.reveal({ type: "openEndpoint" })),
    vscode.commands.registerCommand("hermes.showLog", () => log.show(false)),
    vscode.commands.registerCommand("hermes.exportLogs", async () => {
      const target = await log.export();
      if (target) void vscode.window.showInformationMessage(t(svc.locale, "log.exported", target.fsPath));
    }),
    vscode.commands.registerCommand("hermes.clearAllowlist", () => svc.manageAllowlist()),
    vscode.commands.registerCommand("hermes.removeApprovalHook", () => svc.removeTerminalApprovalHook()),

    // F-12: context from the editor and the explorer.
    vscode.commands.registerCommand("hermes.addSelectionToChat", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.uri.scheme !== "file") return;
      const doc = editor.document;
      const sel = editor.selection;
      await chat.reveal();
      if (sel.isEmpty) {
        svc.addContext({ kind: "file", path: doc.uri.fsPath });
        return;
      }
      const endLine = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1;
      const range = new vscode.Range(sel.start.line, 0, endLine - 1, doc.lineAt(endLine - 1).text.length);
      svc.addContext({ kind: "selection", path: doc.uri.fsPath, startLine: sel.start.line + 1, endLine, text: doc.getText(range) });
    }),
    vscode.commands.registerCommand("hermes.addToChat", async (uri?: vscode.Uri, selected?: vscode.Uri[]) => {
      const targets = selected?.length ? selected : uri ? [uri] : [];
      await chat.reveal();
      for (const u of targets) {
        const stat = await vscode.workspace.fs.stat(u);
        svc.addContext({ kind: stat.type & vscode.FileType.Directory ? "folder" : "file", path: u.fsPath });
      }
    }),

    // F-13
    vscode.commands.registerCommand("hermes.inlineEdit", () => runInlineEdit(svc)),

    // F-14
    vscode.commands.registerCommand("hermes.sessions.refresh", () => sessions.refresh()),
    vscode.commands.registerCommand("hermes.sessions.open", async (s: SessionSummary) => {
      await chat.reveal();
      await svc.openSession(s.id);
    }),
    vscode.commands.registerCommand("hermes.sessions.delete", async (s: SessionSummary) => {
      const loc = svc.locale;
      const confirm = t(loc, "sessions.deleteConfirm");
      const answer = await vscode.window.showWarningMessage(t(loc, "sessions.deleteQuestion", s.title || s.id), { modal: true }, confirm);
      if (answer === confirm) await svc.deleteSession(s.id);
    }),

    // F-17 / F-18
    vscode.commands.registerCommand("hermes.completion.toggle", async () => {
      await vscode.workspace.getConfiguration("hermes.completion").update("enabled", !completion.enabled, vscode.ConfigurationTarget.Global);
    }),
    vscode.commands.registerCommand("hermes.index.rebuild", () => index.rebuild()),
    vscode.commands.registerCommand("hermes.index.search", async () => {
      const loc = svc.locale;
      const query = await vscode.window.showInputBox({ prompt: t(loc, "index.searchPrompt"), ignoreFocusOut: true });
      if (!query?.trim()) return;
      const hits = await index.search(query.trim(), 20);
      const cwd = root();
      if (!hits.length || !cwd) {
        void vscode.window.showInformationMessage(t(loc, "index.noResults"));
        return;
      }
      const picked = await vscode.window.showQuickPick(
        hits.map((h) => ({
          label: `${h.path}:${h.startLine}-${h.endLine}`,
          description: h.score.toFixed(2),
          detail: h.text.split("\n").find((l) => l.trim())?.trim().slice(0, 120),
          hit: h,
        })),
        { matchOnDetail: true, placeHolder: query },
      );
      if (!picked) return;
      const doc = await vscode.workspace.openTextDocument(path.join(cwd, picked.hit.path));
      const range = new vscode.Range(picked.hit.startLine - 1, 0, picked.hit.endLine - 1, 0);
      await vscode.window.showTextDocument(doc, { selection: range });
    }),

    // F-16: quick profile switch (also from the status bar model item).
    vscode.commands.registerCommand("hermes.switchProfile", async () => {
      const loc = svc.locale;
      const { profiles, activeProfileId, hermesConfig } = svc.state.endpoint;
      const picked = await vscode.window.showQuickPick(
        [
          ...profiles.map((p) => ({
            label: `${p.id === activeProfileId ? "$(check) " : ""}${p.name}`,
            description: p.kind === "hermes" ? hermesConfig?.model : p.model,
            detail: p.kind === "hermes" ? hermesConfig?.baseUrl : p.baseUrl,
            id: p.id,
          })),
          { label: `$(add) ${t(loc, "profiles.add")}`, id: "" },
        ],
        { placeHolder: t(loc, "profiles.pick") },
      );
      if (!picked) return;
      if (!picked.id) return chat.reveal({ type: "openEndpoint" });
      await svc.selectProfile(picked.id);
    }),
  );

  statusBar.update(svc.state);
  updateSessionsMessage();
  void svc.refresh();
  void index.reconfigure();
  return { service: svc, reviews, sessions, completion, index };
}

export async function deactivate(): Promise<void> {
  // F-01: stop `hermes acp` when VS Code closes.
  await service?.shutdown();
  await ideMcp?.close();
  service = undefined;
  ideMcp = undefined;
}
