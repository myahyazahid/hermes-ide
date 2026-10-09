// Tab autocomplete (F-17): an inline completion provider backed by a separate FIM endpoint.
// Debounced, cancellable, cached, and it keeps serving the rest of a suggestion while the user
// types the characters it predicted, so most keystrokes need no request at all.
import * as vscode from "vscode";
import { maskKey } from "../core/endpoint";
import { contextWindow, requestFim, wantsMultiline, type FimEndpoint, type FimTemplate } from "../core/fim";
import type { CompletionView } from "../shared/protocol";

export const COMPLETION_SECRET = "hermes.completion.apiKey";
const PREFIX_CHARS = 3000;
const SUFFIX_CHARS = 1000;
const CACHE_SIZE = 64;

interface Pending {
  prefix: string;
  text: string;
}

export class TabCompletion implements vscode.InlineCompletionItemProvider, vscode.Disposable {
  private readonly cache = new Map<string, string>();
  private last: Pending | undefined;
  private apiKey: string | undefined;
  private latencies: number[] = [];
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly statusItem = vscode.window.createStatusBarItem("hermes.completion", vscode.StatusBarAlignment.Right, 99);
  private readonly disposables: vscode.Disposable[] = [this.changed, this.statusItem];
  lastError: string | undefined;
  /** Time from the provider being asked to having a suggestion, for the < 500 ms target. */
  lastTotalMs: number | undefined;

  constructor(private readonly secrets: vscode.SecretStorage) {
    this.statusItem.command = "hermes.completion.toggle";
    this.disposables.push(
      vscode.languages.registerInlineCompletionItemProvider({ pattern: "**" }, this),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("hermes.completion")) {
          this.cache.clear();
          this.last = undefined;
          this.updateStatus();
        }
      }),
    );
    void this.reloadKey();
  }

  private get cfg(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration("hermes.completion");
  }

  get enabled(): boolean {
    return this.cfg.get<boolean>("enabled", false);
  }

  endpoint(): FimEndpoint | undefined {
    const baseUrl = this.cfg.get<string>("baseUrl", "").trim();
    const model = this.cfg.get<string>("model", "").trim();
    if (!baseUrl || !model) return undefined;
    return {
      baseUrl, model, apiKey: this.apiKey,
      template: this.cfg.get<FimTemplate>("template", "auto"),
      maxTokens: this.cfg.get<number>("maxTokens", 96),
    };
  }

  async reloadKey(): Promise<void> {
    this.apiKey = await this.secrets.get(COMPLETION_SECRET);
    this.updateStatus();
  }

  view(): CompletionView {
    const avg = this.latencies.length ? Math.round(this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length) : undefined;
    return {
      enabled: this.enabled,
      baseUrl: this.cfg.get<string>("baseUrl", ""),
      model: this.cfg.get<string>("model", ""),
      template: this.cfg.get<FimTemplate>("template", "auto"),
      keyHint: maskKey(this.apiKey),
      hasKey: !!this.apiKey,
      avgLatencyMs: avg,
      lastError: this.lastError,
    };
  }

  async provideInlineCompletionItems(
    doc: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[]> {
    const started = Date.now();
    const ep = this.enabled ? this.endpoint() : undefined;
    if (!ep || doc.uri.scheme === "hermes-diff" || doc.uri.scheme === "output") return [];

    const text = doc.getText();
    const offset = doc.offsetAt(position);
    const { prefix, suffix } = contextWindow(text, offset, PREFIX_CHARS, SUFFIX_CHARS);
    const item = (completion: string) => {
      this.lastTotalMs = Date.now() - started;
      return [new vscode.InlineCompletionItem(completion, new vscode.Range(position, position))];
    };

    // Typing through a suggestion: serve the remainder without a request.
    if (this.last && prefix.startsWith(this.last.prefix)) {
      const typed = prefix.slice(this.last.prefix.length);
      if (typed && this.last.text.startsWith(typed) && this.last.text.length > typed.length) {
        return item(this.last.text.slice(typed.length));
      }
    }
    const key = `${prefix.slice(-600)}\u0000${suffix.slice(0, 200)}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached ? item(cached) : [];

    if (context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic) {
      await new Promise((r) => setTimeout(r, this.cfg.get<number>("debounceMs", 120)));
      if (token.isCancellationRequested) return [];
    }

    const controller = new AbortController();
    const cancel = token.onCancellationRequested(() => controller.abort());
    try {
      const multiline = wantsMultiline(prefix, suffix);
      const result = await requestFim(ep, prefix, suffix, { multiline, signal: controller.signal });
      this.remember(key, result.text);
      this.recordLatency(result.latencyMs);
      this.lastError = undefined;
      if (token.isCancellationRequested || !result.text) return [];
      this.last = { prefix, text: result.text };
      return item(result.text);
    } catch (error) {
      if (!controller.signal.aborted) {
        this.lastError = (error as Error).message;
        this.updateStatus();
      }
      return [];
    } finally {
      cancel.dispose();
    }
  }

  private remember(key: string, text: string): void {
    this.cache.set(key, text);
    if (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value!);
  }

  private recordLatency(ms: number): void {
    this.latencies.push(ms);
    if (this.latencies.length > 20) this.latencies.shift();
    this.updateStatus();
  }

  updateStatus(): void {
    const configured = !!this.endpoint();
    if (!configured) {
      this.statusItem.hide();
    } else {
      const v = this.view();
      this.statusItem.text = `${this.enabled ? "$(sparkle)" : "$(circle-slash)"} Tab${this.enabled && v.avgLatencyMs !== undefined ? ` ${v.avgLatencyMs}ms` : ""}`;
      this.statusItem.tooltip = `${v.model} · ${v.baseUrl}${this.lastError ? `\n${this.lastError}` : ""}`;
      this.statusItem.backgroundColor = this.lastError ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
      this.statusItem.show();
    }
    this.changed.fire();
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
