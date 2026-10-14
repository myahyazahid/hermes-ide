// Connects the checkpoint store (phase 5) to the extension: picks the storage folder, and makes sure a problem with a
// checkpoint is logged and reported instead of ever breaking the agent's work.
import * as path from "node:path";
import type * as vscode from "vscode";
import { CheckpointStore, type RestorePlan, type RestoreResult } from "../core/checkpoints";
import type { AgentLog } from "./agentLog";

const KEEP_MS = 30 * 24 * 60 * 60 * 1000;

export class CheckpointManager {
  private store: CheckpointStore | undefined;
  private storeCwd: string | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: AgentLog,
    private readonly cwd: () => string | undefined,
  ) {}

  /** The store for the current workspace folder (workspace storage keeps different projects apart). */
  private get(): CheckpointStore | undefined {
    const cwd = this.cwd();
    if (!cwd) return undefined;
    if (!this.store || this.storeCwd !== cwd) {
      const root = path.join((this.context.storageUri ?? this.context.globalStorageUri).fsPath, "checkpoints");
      this.store = new CheckpointStore(root, { cwd });
      this.storeCwd = cwd;
      try {
        const removed = this.store.prune(KEEP_MS);
        if (removed) this.log.info(`checkpoints: removed ${removed} session(s) older than 30 days`);
      } catch (error) {
        this.log.info(`checkpoints: prune failed: ${(error as Error).message}`);
      }
    }
    return this.store;
  }

  private guard<T>(what: string, fallback: T, fn: (store: CheckpointStore) => T): T {
    const store = this.get();
    if (!store) return fallback;
    try {
      return fn(store);
    } catch (error) {
      this.log.info(`checkpoints: ${what} failed: ${(error as Error).message}`);
      return fallback;
    }
  }

  begin(sessionId: string, turn: number, label: string): void {
    this.guard("begin", undefined, (s) => s.begin(sessionId, turn, label));
  }

  /** Snapshots files before the agent writes them. Returns false if that failed, so the caller can tell the user. */
  recordBefore(sessionId: string, turn: number, absPaths: string[]): boolean {
    return this.guard("snapshot", false, (s) => (s.recordBefore(sessionId, turn, absPaths), true));
  }

  noteCommand(sessionId: string, turn: number): void {
    this.guard("noteCommand", undefined, (s) => s.noteCommand(sessionId, turn));
  }

  finish(sessionId: string, turn: number): void {
    this.guard("finish", undefined, (s) => s.finish(sessionId, turn));
  }

  restorableTurns(sessionId: string): Set<number> {
    return this.guard("restorableTurns", new Set<number>(), (s) => s.restorableTurns(sessionId));
  }

  commandTurns(sessionId: string): Set<number> {
    return this.guard("commandTurns", new Set<number>(), (s) => s.commandTurns(sessionId));
  }

  canUndo(sessionId: string): boolean {
    return this.guard("canUndo", false, (s) => s.canUndo(sessionId));
  }

  plan(sessionId: string, turn: number): RestorePlan | undefined {
    return this.guard<RestorePlan | undefined>("plan", undefined, (s) => s.plan(sessionId, turn));
  }

  /** Throws on failure: the caller shows the error, the store has already rolled back. */
  restore(sessionId: string, turn: number): RestoreResult {
    const store = this.get();
    if (!store) throw new Error("no workspace");
    return store.restore(sessionId, turn);
  }

  undoRestore(sessionId: string): RestoreResult | undefined {
    const store = this.get();
    if (!store) return undefined;
    return store.undoRestore(sessionId);
  }
}
