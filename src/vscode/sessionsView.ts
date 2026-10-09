// "Agent Sessions" in the Explorer (F-14), as in the Dream IDE mockup: list, resume, delete.
import * as vscode from "vscode";
import { relativeTime } from "../core/time";
import { t, type Locale } from "../shared/strings";

export interface SessionSummary {
  id: string;
  title: string;
  updatedAt?: string;
}

export interface SessionsSource {
  readonly locale: Locale;
  readonly currentSessionId: string | undefined;
  readonly busy: boolean;
  listSessions(): Promise<SessionSummary[]>;
}

export class SessionsView implements vscode.TreeDataProvider<SessionSummary>, vscode.Disposable {
  static readonly viewId = "hermes.sessions";
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly source: SessionsSource) {}

  refresh(): void {
    this.changed.fire();
  }

  async getChildren(element?: SessionSummary): Promise<SessionSummary[]> {
    if (element) return [];
    try {
      return await this.source.listSessions();
    } catch {
      return [];
    }
  }

  getTreeItem(s: SessionSummary): vscode.TreeItem {
    const loc = this.source.locale;
    const current = s.id === this.source.currentSessionId;
    const item = new vscode.TreeItem(s.title || t(loc, "sessions.untitled"), vscode.TreeItemCollapsibleState.None);
    const when = relativeTime(s.updatedAt, loc);
    const status = current ? t(loc, this.source.busy ? "sessions.running" : "sessions.open") : t(loc, "sessions.done");
    item.description = when ? `${status} · ${when}` : status;
    item.tooltip = `${s.title}\n${s.id}`;
    item.id = s.id;
    item.contextValue = current ? "hermesSession.current" : "hermesSession";
    item.iconPath = new vscode.ThemeIcon(current ? (this.source.busy ? "loading~spin" : "comment-discussion") : "history");
    item.command = { command: "hermes.sessions.open", title: t(loc, "sessions.open"), arguments: [s] };
    return item;
  }

  dispose(): void {
    this.changed.dispose();
  }
}
