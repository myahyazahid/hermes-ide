// Hosts the React chat as a webview view (sidebar) or an editor tab and relays messages to HermesService.
import * as vscode from "vscode";
import { supportsSecondarySidebar } from "../core/sidebar";
import type { HostToView, ViewToHost } from "../shared/protocol";
import type { HermesService } from "./hermesService";

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.WebviewPanelSerializer {
  /** Activity bar view; present in every VS Code build. */
  static readonly viewId = "hermes.chat";
  /** Secondary Side Bar view: the tab next to Chat / Codex / Claude Code. */
  static readonly secondaryViewId = "hermes.chatSecondary";
  /** The same chat opened as an editor tab (the button in the editor toolbar). */
  static readonly panelViewType = "hermes.chatPanel";
  /** Both sidebar views can be open at once (activity bar and Secondary Side Bar), so keep them apart. */
  private readonly views = new Map<string, vscode.WebviewView>();
  private panel: vscode.WebviewPanel | undefined;

  /** The view `hermes.openChat` focuses: the Secondary Side Bar tab where it exists, else the activity bar one. */
  static activeViewId(): string {
    return supportsSecondarySidebar(vscode.version) ? ChatViewProvider.secondaryViewId : ChatViewProvider.viewId;
  }

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly service: HermesService,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.views.set(view.viewType, view);
    this.wire(view, () => {
      if (this.views.get(view.viewType) === view) this.views.delete(view.viewType);
    });
  }

  /** Opens the chat in an editor tab, or brings the tab that is already open to the front. */
  openInEditor(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(ChatViewProvider.panelViewType, "Hermes", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    this.adopt(panel);
  }

  /** Brings the editor tab back after VS Code was reloaded. */
  deserializeWebviewPanel(panel: vscode.WebviewPanel): Promise<void> {
    this.panel?.dispose();
    this.adopt(panel);
    return Promise.resolve();
  }

  async reveal(then?: HostToView): Promise<void> {
    await vscode.commands.executeCommand(`${ChatViewProvider.activeViewId()}.focus`);
    if (then) void this.views.get(ChatViewProvider.activeViewId())?.webview.postMessage(then);
  }

  private adopt(panel: vscode.WebviewPanel): void {
    this.panel = panel;
    panel.iconPath = {
      light: vscode.Uri.joinPath(this.extensionUri, "media", "hermes-light.svg"),
      dark: vscode.Uri.joinPath(this.extensionUri, "media", "hermes-dark.svg"),
    };
    this.wire(panel, () => {
      if (this.panel === panel) this.panel = undefined;
    });
  }

  private wire(host: { webview: vscode.Webview; onDidDispose: vscode.Event<void> }, onGone: () => void): void {
    const dist = vscode.Uri.joinPath(this.extensionUri, "dist");
    host.webview.options = { enableScripts: true, localResourceRoots: [dist] };
    host.webview.html = this.html(host.webview, dist);

    const post = (msg: HostToView) => void host.webview.postMessage(msg);
    const attached = this.service.attachView(post);
    // Passing `post` lets the service answer this view's own requests (mentions, session list) without echoing them elsewhere.
    const received = host.webview.onDidReceiveMessage((msg: ViewToHost) => void this.service.handleViewMessage(msg, post));
    host.onDidDispose(() => {
      attached.dispose();
      received.dispose();
      onGone();
    });
  }

  private html(webview: vscode.Webview, dist: vscode.Uri): string {
    const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const script = webview.asWebviewUri(vscode.Uri.joinPath(dist, "webview.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(dist, "webview.css"));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data:`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${style}">
  <title>Hermes Agent</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}
