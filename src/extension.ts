import * as vscode from "vscode";
import { t } from "./shared/strings";
import { AgentLog } from "./vscode/agentLog";
import { ChatViewProvider } from "./vscode/chatView";
import { DiffReviewManager } from "./vscode/diffReview";
import { HermesService } from "./vscode/hermesService";
import { HermesStatusBar } from "./vscode/statusBar";

let service: HermesService | undefined;

/** Returned from activate() so the extension-host tests can drive the service directly. */
export interface HermesIdeApi {
  service: HermesService;
  reviews: DiffReviewManager;
}

export function activate(context: vscode.ExtensionContext): HermesIdeApi {
  const log = new AgentLog();
  // The review manager is created first; its selection callback is wired once the service exists.
  let onSelection: (id: string, accepted: number, total: number) => void = () => {};
  const reviews = new DiffReviewManager(() => service?.locale ?? "en", (id, a, n) => onSelection(id, a, n));
  service = new HermesService(context, log, reviews);
  const svc = service;
  onSelection = (id, a, n) => svc.onReviewSelectionChanged(id, a, n);

  const statusBar = new HermesStatusBar(() => svc.locale);
  const chat = new ChatViewProvider(context.extensionUri, svc);

  context.subscriptions.push(
    log,
    reviews,
    svc,
    statusBar,
    svc.onDidChangeState((s) => statusBar.update(s)),
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
  );

  statusBar.update(svc.state);
  void svc.refresh();
  return { service: svc, reviews };
}

export async function deactivate(): Promise<void> {
  // F-01: stop `hermes acp` when VS Code closes.
  await service?.shutdown();
  service = undefined;
}
