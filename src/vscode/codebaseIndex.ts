// Codebase index (F-18): embeds workspace files in line chunks through a separate embeddings
// endpoint and keeps them in a local vector store, updated incrementally when files change.
// Results feed @codebase in the composer and the `codebase_search` MCP tool Hermes can call.
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { chunkText, embeddingInput, shouldIndex } from "../core/chunker";
import { embed, type EmbeddingEndpoint } from "../core/embeddings";
import { maskKey } from "../core/endpoint";
import type { McpTool } from "../core/mcpHttpServer";
import { VectorStore, type SearchHit } from "../core/vectorStore";
import type { IndexView } from "../shared/protocol";
import type { AgentLog } from "./agentLog";
import { blockedByLocalMode } from "./privacyGate";

export const INDEX_SECRET = "hermes.index.apiKey";
const EXCLUDE = "**/{node_modules,.git,dist,out,build,.venv,venv,vendor,__pycache__,.next,.dart_tool,coverage,target}/**";
const MAX_FILES = 20_000;
const FLUSH_INPUTS = 64;
const SAVE_EVERY_MS = 10_000;

type Status = IndexView["status"];

export class CodebaseIndex implements vscode.Disposable {
  private store: VectorStore | undefined;
  private apiKey: string | undefined;
  private status: Status = "disabled";
  private progress: { done: number; total: number } | undefined;
  private error: string | undefined;
  private running: Promise<void> | undefined;
  private cancelRun: AbortController | undefined;
  private dirtyTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly disposables: vscode.Disposable[] = [this.changed];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: AgentLog,
    private readonly root: () => string | undefined,
  ) {
    const watcher = vscode.workspace.createFileSystemWatcher("**/*");
    const mark = (uri: vscode.Uri) => this.markDirty(uri.fsPath);
    this.disposables.push(
      watcher,
      watcher.onDidChange(mark),
      watcher.onDidCreate(mark),
      watcher.onDidDelete(mark),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("hermes.index") || e.affectsConfiguration("hermes.privacy")) void this.reconfigure();
      }),
    );
  }

  private get cfg(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration("hermes.index");
  }

  get enabled(): boolean {
    return this.cfg.get<boolean>("enabled", false);
  }

  endpoint(): EmbeddingEndpoint | undefined {
    const baseUrl = this.cfg.get<string>("baseUrl", "").trim();
    const model = this.cfg.get<string>("model", "").trim();
    if (baseUrl && blockedByLocalMode(baseUrl)) return undefined; // full local mode: code is never embedded remotely
    return baseUrl && model ? { baseUrl, model, apiKey: this.apiKey } : undefined;
  }

  view(): IndexView {
    return {
      enabled: this.enabled,
      blocked: this.enabled && blockedByLocalMode(this.cfg.get<string>("baseUrl", "")),
      baseUrl: this.cfg.get<string>("baseUrl", ""),
      model: this.cfg.get<string>("model", ""),
      keyHint: maskKey(this.apiKey),
      hasKey: !!this.apiKey,
      status: this.status,
      files: this.store?.fileCount ?? 0,
      chunks: this.store?.size ?? 0,
      done: this.progress?.done,
      total: this.progress?.total,
      error: this.error,
    };
  }

  get ready(): boolean {
    return !!this.store && this.store.size > 0;
  }

  /** Loads the saved index and brings it up to date. Called on activation and on settings change. */
  async reconfigure(): Promise<void> {
    this.apiKey = await this.context.secrets.get(INDEX_SECRET);
    this.cancelRun?.abort();
    await this.running?.catch(() => {});
    const ep = this.endpoint();
    if (!this.enabled || !ep || !this.root()) {
      this.store = undefined;
      const blocked = this.enabled && blockedByLocalMode(this.cfg.get<string>("baseUrl", ""));
      this.setStatus(this.enabled && !ep && !blocked ? "needsSetup" : "disabled");
      return;
    }
    this.store = (await this.load(ep.model)) ?? new VectorStore(ep.model);
    this.setStatus(this.store.size ? "ready" : "idle");
    void this.sync();
  }

  /** Full scan: embeds new or changed files and drops deleted ones. */
  sync(): Promise<void> {
    this.running ??= this.runSync().finally(() => (this.running = undefined));
    return this.running;
  }

  async rebuild(): Promise<void> {
    const ep = this.endpoint();
    if (!ep) return;
    this.cancelRun?.abort();
    await this.running?.catch(() => {});
    this.store = new VectorStore(ep.model);
    await this.sync();
  }

  async search(query: string, k = 8): Promise<SearchHit[]> {
    const ep = this.endpoint();
    if (!ep || !this.store?.size) return [];
    const [vector] = await embed(ep, [query]);
    return this.store.search(vector, k);
  }

  /** `codebase_search` for Hermes, served by the IDE's MCP server. */
  mcpTool(): McpTool {
    return {
      name: "codebase_search",
      description:
        "Semantic search over the current workspace (embedding index kept by the IDE). Use it to find where something " +
        "is implemented when you do not know the file name. Returns file paths with line ranges and the matching code.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "What you are looking for, in natural language or code terms." },
          limit: { type: "number", description: "Maximum results (default 8, max 20)." },
        },
        required: ["query"],
      },
      call: async (args) => {
        const query = String(args.query ?? "").trim();
        if (!query) return { text: "query is required", isError: true };
        if (!this.ready) return { text: `The codebase index is not ready (status: ${this.status}). Use search_files instead.`, isError: true };
        const hits = await this.search(query, Math.min(20, Math.max(1, Number(args.limit) || 8)));
        return { text: formatHits(hits) || "No results." };
      },
    };
  }

  private async runSync(): Promise<void> {
    const ep = this.endpoint();
    const root = this.root();
    const store = this.store;
    if (!ep || !root || !store) return;
    const controller = new AbortController();
    this.cancelRun = controller;
    const maxBytes = this.cfg.get<number>("maxFileKB", 256) * 1024;
    this.error = undefined;
    try {
      const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(root, "**/*"), EXCLUDE, MAX_FILES);
      const files = new Map<string, string>();
      for (const u of uris) files.set(toRel(root, u.fsPath), u.fsPath);
      for (const known of store.paths()) if (!files.has(known)) store.removeFile(known);

      const todo: { rel: string; abs: string; fingerprint: string }[] = [];
      for (const [rel, abs] of files) {
        const s = await stat(abs).catch(() => undefined);
        if (!s || !shouldIndex(rel, s.size, maxBytes)) {
          store.removeFile(rel);
          continue;
        }
        const fingerprint = `${s.size}:${Math.floor(s.mtimeMs)}`;
        if (store.fingerprint(rel) !== fingerprint) todo.push({ rel, abs, fingerprint });
      }
      if (!todo.length) {
        this.setStatus(store.size ? "ready" : "idle");
        await this.save();
        return;
      }
      this.log.info(`codebase index: ${todo.length} file(s) to embed (${store.fileCount} up to date)`);
      this.progress = { done: 0, total: todo.length };
      this.setStatus("indexing");
      await this.embedFiles(ep, todo, controller.signal);
      this.progress = undefined;
      this.setStatus(store.size ? "ready" : "idle");
      this.log.info(`codebase index: ${store.fileCount} files, ${store.size} chunks`);
    } catch (error) {
      this.progress = undefined;
      if (controller.signal.aborted) return;
      this.error = (error as Error).message;
      this.log.info(`codebase index failed: ${this.error}`);
      this.setStatus("error");
    } finally {
      await this.save().catch(() => {});
    }
  }

  private async embedFiles(ep: EmbeddingEndpoint, todo: { rel: string; abs: string; fingerprint: string }[], signal: AbortSignal): Promise<void> {
    const store = this.store!;
    let batch: { rel: string; fingerprint: string; chunks: ReturnType<typeof chunkText> }[] = [];
    let inputs = 0;
    let lastSave = Date.now();
    const flush = async () => {
      if (!batch.length) return;
      const texts = batch.flatMap((f) => f.chunks.map((c) => embeddingInput(f.rel, c)));
      const vectors = texts.length ? await embed(ep, texts, { signal }) : [];
      let i = 0;
      for (const f of batch) {
        store.setFile(f.rel, f.fingerprint, f.chunks, vectors.slice(i, i + f.chunks.length));
        i += f.chunks.length;
      }
      this.progress!.done += batch.length;
      batch = [];
      inputs = 0;
      this.changed.fire();
      if (Date.now() - lastSave > SAVE_EVERY_MS) {
        await this.save();
        lastSave = Date.now();
      }
    };
    for (const f of todo) {
      if (signal.aborted) return;
      const text = await readFile(f.abs, "utf8").catch(() => "");
      const chunks = chunkText(text);
      batch.push({ rel: f.rel, fingerprint: f.fingerprint, chunks });
      inputs += chunks.length;
      if (inputs >= FLUSH_INPUTS) await flush();
    }
    await flush();
  }

  private markDirty(abs: string): void {
    const root = this.root();
    if (!root || !this.enabled || !this.store || !isInside(root, abs)) return;
    if (/(^|\/)(node_modules|\.git|dist|out|build)\//.test(toRel(root, abs))) return;
    if (this.dirtyTimer) clearTimeout(this.dirtyTimer);
    // Saves come in bursts (format on save, agent edits): settle first, then rescan. Unchanged
    // files are skipped by their size/mtime fingerprint, so a rescan is cheap.
    this.dirtyTimer = setTimeout(() => void this.sync(), 2000);
  }

  private storageDir(): string {
    return (this.context.storageUri ?? this.context.globalStorageUri).fsPath;
  }

  private async load(model: string): Promise<VectorStore | undefined> {
    const dir = this.storageDir();
    try {
      const [meta, vectors] = await Promise.all([readFile(path.join(dir, "index.json"), "utf8"), readFile(path.join(dir, "index.bin"))]);
      return VectorStore.deserialize(meta, vectors, model);
    } catch {
      return undefined;
    }
  }

  private async save(): Promise<void> {
    if (!this.store) return;
    const dir = this.storageDir();
    await mkdir(dir, { recursive: true });
    const { meta, vectors } = this.store.serialize();
    await writeFile(path.join(dir, "index.bin"), vectors);
    await writeFile(path.join(dir, "index.json"), meta, "utf8");
  }

  private setStatus(status: Status): void {
    this.status = status;
    this.changed.fire();
  }

  dispose(): void {
    this.cancelRun?.abort();
    if (this.dirtyTimer) clearTimeout(this.dirtyTimer);
    for (const d of this.disposables) d.dispose();
  }
}

export function formatHits(hits: SearchHit[]): string {
  return hits
    .map((h) => `${h.path}:${h.startLine}-${h.endLine} (score ${h.score.toFixed(2)})\n\`\`\`\n${h.text}\n\`\`\``)
    .join("\n\n");
}

function toRel(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join("/");
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}
