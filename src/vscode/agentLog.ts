// "Hermes Agent Log" output channel (F-02) plus an in-memory ring buffer so logs can be exported
// for debugging. Known secrets are masked before anything is written.
import * as vscode from "vscode";

const MAX_LINES = 5000;

export class AgentLog implements vscode.Disposable {
  private readonly channel = vscode.window.createOutputChannel("Hermes Agent Log");
  private readonly buffer: string[] = [];
  private secrets: string[] = [];

  setSecrets(secrets: (string | undefined)[]): void {
    this.secrets = secrets.filter((s): s is string => !!s && s.length >= 6);
  }

  /** Extension-side event. */
  info(message: string): void {
    this.append(`${timestamp()} [ide] ${message}`);
  }

  /** Raw stderr line from Hermes (already timestamped by Hermes). */
  hermes(line: string): void {
    this.append(line);
  }

  show(preserveFocus = true): void {
    this.channel.show(preserveFocus);
  }

  async export(): Promise<vscode.Uri | undefined> {
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(`hermes-ide-log-${new Date().toISOString().replace(/[:.]/g, "-")}.log`),
      filters: { Log: ["log", "txt"] },
    });
    if (!target) return undefined;
    await vscode.workspace.fs.writeFile(target, Buffer.from(this.buffer.join("\n") + "\n", "utf8"));
    return target;
  }

  dispose(): void {
    this.channel.dispose();
  }

  private append(line: string): void {
    const safe = this.mask(line);
    this.buffer.push(safe);
    if (this.buffer.length > MAX_LINES) this.buffer.splice(0, this.buffer.length - MAX_LINES);
    this.channel.appendLine(safe);
  }

  private mask(line: string): string {
    let out = line;
    for (const s of this.secrets) out = out.split(s).join("••••");
    return out;
  }
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
