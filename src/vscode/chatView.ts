// Hosts the React chat as a webview view (sidebar) or editor tabs. Each host gets its own HermesService from the
// hub, so every panel runs its own session, as in Claude Code.
import * as vscode from "vscode";
import { supportsSecondarySidebar } from "../core/sidebar";
import type { HostToView, ViewToHost } from "../shared/protocol";
import type { ChatHub } from "./chatHub";
import type { HermesService } from "./hermesService";

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.WebviewPanelSerializer {
  /** Activity bar view; present in every VS Code build. */
  static readonly viewId = "hermes.chat";
  /** Secondary Side Bar view: the tab next to Chat / Codex / Claude Code. */
  static readonly secondaryViewId = "hermes.chatSecondary";
  /** The chat opened as an editor tab (the button in the editor toolbar); each tab is a session of its own. */
  static readonly panelViewType = "hermes.chatPanel";
  /** How to bring each service's panel to the front. */
  private readonly hosts = new Map<HermesService, () => Thenable<unknown>>();

  /** The view `hermes.openChat` focuses: the Secondary Side Bar tab where it exists, else the activity bar one. */
  static activeViewId(): string {
    return supportsSecondarySidebar(vscode.version) ? ChatViewProvider.secondaryViewId : ChatViewProvider.viewId;
  }

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly hub: ChatHub,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    const service = this.wire(view, () => vscode.commands.executeCommand(`${view.viewType}.focus`));
    view.onDidChangeVisibility(() => {
      if (view.visible) this.hub.touch(service);
    });
  }

  /** Opens a new chat in an editor tab, with a session of its own. */
  openInEditor(): void {
    const panel = vscode.window.createWebviewPanel(ChatViewProvider.panelViewType, "Hermes", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    this.adopt(panel);
  }

  /** Brings an editor tab back after VS Code was reloaded. */
  deserializeWebviewPanel(panel: vscode.WebviewPanel): Promise<void> {
    this.adopt(panel);
    return Promise.resolve();
  }

  /** Brings the panel used last to the front (the default sidebar view when none is open), then sends it `then`. */
  async reveal(then?: HostToView): Promise<void> {
    const show = this.hosts.get(this.hub.active);
    await (show ? show() : vscode.commands.executeCommand(`${ChatViewProvider.activeViewId()}.focus`));
    if (then) this.hub.active.showInView(then);
  }

  private adopt(panel: vscode.WebviewPanel): void {
    panel.iconPath = {
      light: vscode.Uri.joinPath(this.extensionUri, "media", "nous-tile-light.png"),
      dark: vscode.Uri.joinPath(this.extensionUri, "media", "nous-tile-dark.png"),
    };
    const service = this.wire(panel, () => {
      panel.reveal();
      return Promise.resolve();
    });
    panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active) this.hub.touch(service);
    });
  }

  private wire(host: { webview: vscode.Webview; onDidDispose: vscode.Event<void> }, show: () => Thenable<unknown>): HermesService {
    const dist = vscode.Uri.joinPath(this.extensionUri, "dist");
    host.webview.options = { enableScripts: true, localResourceRoots: [dist] };
    host.webview.html = this.html(host.webview, dist);

    const service = this.hub.acquire();
    const post = (msg: HostToView) => void host.webview.postMessage(msg);
    const attached = service.attachView(post);
    this.hosts.set(service, show);
    this.hub.touch(service);
    // Passing `post` lets the service answer this view's own requests (mentions, session list) without echoing them elsewhere.
    const received = host.webview.onDidReceiveMessage((msg: ViewToHost) => {
      this.hub.touch(service);
      void service.handleViewMessage(msg, post);
    });
    host.onDidDispose(() => {
      attached.dispose();
      received.dispose();
      if (this.hosts.get(service) === show) this.hosts.delete(service);
      this.hub.release(service);
    });
    return service;
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
