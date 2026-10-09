// Workspace file list for @-mentions (F-12) and folder listings. Cached briefly; rebuilt on demand.
import * as path from "node:path";
import * as vscode from "vscode";
import { fuzzyScore } from "../core/context";
import type { MentionItem } from "../shared/protocol";

const EXCLUDE = "**/{node_modules,.git,dist,out,build,.venv,venv,vendor,__pycache__,.next,.dart_tool}/**";
const MAX_FILES = 20_000;
const TTL_MS = 20_000;

export class FileIndex {
  private files: string[] = [];
  private builtAt = 0;
  private building: Promise<void> | undefined;

  constructor(private readonly root: () => string | undefined) {}

  async search(query: string, limit = 30): Promise<MentionItem[]> {
    await this.ensure();
    const cwd = this.root();
    if (!cwd) return [];
    const q = query.replace(/\\/g, "/");
    const folders = new Set<string>();
    for (const f of this.files) {
      let dir = path.posix.dirname(f);
      while (dir && dir !== "." && !folders.has(dir)) {
        folders.add(dir);
        dir = path.posix.dirname(dir);
      }
    }
    const scored: { item: MentionItem; score: number }[] = [];
    for (const f of this.files) {
      const s = fuzzyScore(q, f);
      if (s >= 0) scored.push({ score: s, item: { kind: "file", label: f, path: path.join(cwd, f) } });
    }
    for (const d of folders) {
      const s = fuzzyScore(q, d);
      // Folders rank slightly below files with the same score.
      if (s >= 0) scored.push({ score: s - 0.5, item: { kind: "folder", label: `${d}/`, path: path.join(cwd, d) } });
    }
    scored.sort((a, b) => b.score - a.score || a.item.label.length - b.item.label.length);
    return scored.slice(0, limit).map((s) => s.item);
  }

  /** Workspace-relative files under a folder, for @folder context. */
  listFolder(folder: string): string[] {
    const cwd = this.root();
    if (!cwd) return [];
    const rel = path.relative(cwd, folder).split(path.sep).join("/");
    const prefix = rel && rel !== "." ? `${rel}/` : "";
    return this.files.filter((f) => f.startsWith(prefix)).map((f) => f.slice(prefix.length));
  }

  async ensure(): Promise<void> {
    if (Date.now() - this.builtAt < TTL_MS && this.files.length) return;
    this.building ??= this.build().finally(() => (this.building = undefined));
    return this.building;
  }

  private async build(): Promise<void> {
    const cwd = this.root();
    if (!cwd) return;
    const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(cwd, "**/*"), EXCLUDE, MAX_FILES);
    this.files = uris.map((u) => path.relative(cwd, u.fsPath).split(path.sep).join("/")).sort();
    this.builtAt = Date.now();
  }
}
