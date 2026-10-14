// Watches and opens the project rules files (phase 5): .hermes/rules.md and .hermes/rules/*.md.
import { mkdir, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { loadProjectRules, RULES_FILE, RULES_TEMPLATE, type ProjectRules } from "../core/rules";
import type { RulesView } from "../shared/protocol";
import type { Locale } from "../shared/strings";

export class ProjectRulesWatcher implements vscode.Disposable {
  private watcher: vscode.FileSystemWatcher | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(private readonly root: () => string | undefined, private readonly onChange: () => void) {
    this.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => this.watch()));
    this.watch();
  }

  /** Fresh read from disk; rules are small and read once per prompt. */
  load(): ProjectRules | undefined {
    const root = this.root();
    return root ? loadProjectRules(root) : undefined;
  }

  view(): RulesView | undefined {
    const rules = this.load();
    return rules ? { files: rules.files.map((f) => f.path), bytes: rules.files.reduce((n, f) => n + f.bytes, 0), truncated: rules.truncated } : undefined;
  }

  /** Opens the rules file, creating .hermes/rules.md from the template first if the project has none. Returns the path created, if any. */
  async openOrCreate(locale: Locale): Promise<{ created?: string }> {
    const root = this.root();
    if (!root) return {};
    const existing = this.load();
    if (existing) {
      await vscode.window.showTextDocument(vscode.Uri.file(path.join(root, ...existing.files[0].path.split("/"))));
      return {};
    }
    const file = path.join(root, ...RULES_FILE.split("/"));
    await mkdir(path.dirname(file), { recursive: true });
    // `wx` never overwrites: a file that exists but is empty or whitespace-only still counts as the user's file.
    const exists = await stat(file).then(() => true, () => false);
    if (!exists) await writeFile(file, RULES_TEMPLATE[locale], { encoding: "utf8", flag: "wx" });
    await vscode.window.showTextDocument(vscode.Uri.file(file));
    return exists ? {} : { created: RULES_FILE };
  }

  private watch(): void {
    this.watcher?.dispose();
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return;
    this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, "{.hermes/rules.md,.hermes/rules/**}"));
    const changed = () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.onChange(), 200);
    };
    this.watcher.onDidCreate(changed);
    this.watcher.onDidChange(changed);
    this.watcher.onDidDelete(changed);
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.watcher?.dispose();
    for (const s of this.subscriptions) s.dispose();
  }
}
