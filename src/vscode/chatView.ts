// Hosts the React chat panel as a webview view and relays messages to HermesService.
import * as vscode from "vscode";
import type { HostToView, ViewToHost } from "../shared/protocol";
import type { HermesService } from "./hermesService";

export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = "hermes.chat";
  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly service: HermesService,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const dist = vscode.Uri.joinPath(this.extensionUri, "dist");
    view.webview.options = { enableScripts: true, localResourceRoots: [dist] };
    view.webview.html = this.html(view.webview, dist);

    const attached = this.service.attachView((msg: HostToView) => void view.webview.postMessage(msg));
    const received = view.webview.onDidReceiveMessage((msg: ViewToHost) => void this.service.handleViewMessage(msg));
    view.onDidDispose(() => {
      attached.dispose();
      received.dispose();
      if (this.view === view) this.view = undefined;
    });
  }

  async reveal(then?: HostToView): Promise<void> {
    await vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
    if (then) void this.view?.webview.postMessage(then);
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
