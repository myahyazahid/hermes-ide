// Checkpoints (phase 5): just before the agent changes a file, its content is saved, per chat turn. "Restore to here"
// puts every file the agent touched since that turn back, and the restore itself can be undone, so no step is final.
//
// Scope, stated plainly: this covers edits the agent makes through its file tools, because those pass through the
// IDE's permission step. Changes made by terminal commands (sed -i, git checkout, npm install...) happen outside it
// and are not tracked; the host warns about turns that ran commands.
//
// Storage: <root>/<session>/manifest.json plus content-addressed <root>/_blobs/<sha256>, shared by all sessions. All filesystem work is synchronous
// on purpose: the snapshot must be on disk before the host lets the agent write.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";

export const MAX_TRACKED_FILE_BYTES = 5 * 1024 * 1024;

export interface CheckpointFile {
  /** Workspace-relative with forward slashes; absolute for files outside the workspace. */
  path: string;
  /** sha256 of the content before the agent first touched it in this turn; null when the file did not exist. */
  before: string | null;
  /** Content hash when the turn finished; null when the file was deleted. Unset while the turn is running. */
  after?: string | null;
  skipped?: "outside" | "too-large";
}

export interface Checkpoint {
  turn: number;
  at: number;
  label: string;
  files: CheckpointFile[];
  /** A terminal command was allowed during this turn; its effects on files are not tracked. */
  ranCommand?: boolean;
}

interface UndoInfo {
  at: number;
  turn: number;
  items: { path: string; prev: string | null }[];
  dropped: Checkpoint[];
}

interface Manifest {
  v: 1;
  sessionId: string;
  checkpoints: Checkpoint[];
  undo?: UndoInfo;
}

export interface PlanItem {
  path: string;
  abs: string;
  action: "write" | "delete";
  /** Blob to write back; null for delete. */
  target: string | null;
  /** The file differs from what the agent last left, i.e. someone changed it since. Restoring overwrites that. */
  modifiedSince: boolean;
}

export interface RestorePlan {
  turn: number;
  items: PlanItem[];
  skipped: { path: string; reason: "outside" | "too-large" }[];
  ranCommand: boolean;
}

export interface RestoreResult {
  written: number;
  deleted: number;
  skipped: RestorePlan["skipped"];
}

const BLOB_DIR = "_blobs";

type Snapshot = { kind: "absent" } | { kind: "file"; sha: string } | { kind: "too-large" } | { kind: "dir" };

const sha256 = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");

export class CheckpointStore {
  private readonly cache = new Map<string, Manifest>();
  private readonly cwd: string;
  private readonly now: () => number;
  private readonly maxBytes: number;
  private readonly caseInsensitive: boolean;

  /** `root` is the folder for this workspace's checkpoints; `cwd` the workspace root the agent works in. */
  constructor(private readonly root: string, opts: { cwd: string; now?: () => number; maxFileBytes?: number; caseInsensitive?: boolean }) {
    this.cwd = path.resolve(opts.cwd);
    this.now = opts.now ?? Date.now;
    this.maxBytes = opts.maxFileBytes ?? MAX_TRACKED_FILE_BYTES;
    this.caseInsensitive = opts.caseInsensitive ?? process.platform === "win32";
  }

  // ---- recording ----------------------------------------------------------------------------

  /** Starts (or reuses) the checkpoint for a chat turn. */
  begin(sessionId: string, turn: number, label: string): void {
    this.checkpoint(this.load(sessionId), turn, label);
    this.save(sessionId);
  }

  /** Saves the current content of each file. Call before the agent is allowed to write. The first save per turn wins. */
  recordBefore(sessionId: string, turn: number, absPaths: string[]): void {
    const m = this.load(sessionId);
    const cp = this.checkpoint(m, turn, "");
    for (const raw of absPaths) {
      const abs = path.resolve(raw);
      const rel = this.relative(abs);
      if (rel === undefined) {
        if (!cp.files.some((f) => f.path === abs)) cp.files.push({ path: abs, before: null, skipped: "outside" });
        continue;
      }
      if (cp.files.some((f) => this.sameKey(f.path, rel))) continue;
      const snap = this.snapshot(abs, true);
      if (snap.kind === "dir") continue;
      if (snap.kind === "too-large") cp.files.push({ path: rel, before: null, skipped: "too-large" });
      else cp.files.push({ path: rel, before: snap.kind === "file" ? snap.sha : null });
    }
    this.save(sessionId);
  }

  /** A terminal command was allowed in this turn. */
  noteCommand(sessionId: string, turn: number): void {
    const cp = this.checkpoint(this.load(sessionId), turn, "");
    cp.ranCommand = true;
    this.save(sessionId);
  }

  /** The turn is over: remember what each touched file looks like now, to tell later changes by someone else. */
  finish(sessionId: string, turn: number): void {
    const m = this.load(sessionId);
    const cp = m.checkpoints.find((c) => c.turn === turn);
    if (!cp) return;
    for (const f of cp.files) {
      if (f.skipped) continue;
      const current = this.hashCurrent(path.join(this.cwd, ...f.path.split("/")));
      if (current !== "unknown") f.after = current;
    }
    this.save(sessionId);
  }

  // ---- queries ------------------------------------------------------------------------------

  /** Turns in which the agent actually changed something a restore could undo. */
  restorableTurns(sessionId: string): Set<number> {
    const out = new Set<number>();
    for (const cp of this.load(sessionId).checkpoints) {
      if (cp.files.some((f) => !f.skipped && (f.after === undefined || f.after !== f.before))) out.add(cp.turn);
    }
    return out;
  }

  /** Turns that ran terminal commands: restoring them cannot undo what the commands did. */
  commandTurns(sessionId: string): Set<number> {
    return new Set(this.load(sessionId).checkpoints.filter((c) => c.ranCommand).map((c) => c.turn));
  }

  canUndo(sessionId: string): boolean {
    return !!this.load(sessionId).undo;
  }

  // ---- restore ------------------------------------------------------------------------------

  /** What restoring to the state before `turn` would do. Changes nothing. */
  plan(sessionId: string, turn: number): RestorePlan {
    const later = this.load(sessionId).checkpoints.filter((c) => c.turn >= turn).sort((a, b) => a.turn - b.turn);
    const byKey = new Map<string, { first: CheckpointFile; last: CheckpointFile }>();
    const skipped = new Map<string, "outside" | "too-large">();
    for (const cp of later) {
      for (const f of cp.files) {
        if (f.skipped) {
          skipped.set(f.path, f.skipped);
          continue;
        }
        const key = this.key(f.path);
        const entry = byKey.get(key);
        if (entry) entry.last = f;
        else byKey.set(key, { first: f, last: f });
      }
    }
    const items: PlanItem[] = [];
    for (const { first, last } of byKey.values()) {
      const abs = path.join(this.cwd, ...first.path.split("/"));
      const current = this.hashCurrent(abs);
      if (current === "unknown") {
        skipped.set(first.path, "too-large");
        continue;
      }
      if (current === first.before) continue; // already in the wanted state
      items.push({
        path: first.path,
        abs,
        action: first.before === null ? "delete" : "write",
        target: first.before,
        modifiedSince: last.after !== undefined && current !== last.after,
      });
    }
    items.sort((a, b) => a.path.localeCompare(b.path));
    return {
      turn,
      items,
      skipped: [...skipped].map(([p, reason]) => ({ path: p, reason })),
      ranCommand: later.some((c) => c.ranCommand),
    };
  }

  /** Puts files back to the state before `turn`. Records an undo first; rolls back if anything fails midway. */
  restore(sessionId: string, turn: number): RestoreResult {
    const plan = this.plan(sessionId, turn);
    const m = this.load(sessionId);
    const dropped = m.checkpoints.filter((c) => c.turn >= turn);
    const undoItems = plan.items.map((it) => ({ path: it.path, prev: this.storeBlob(it.abs) }));
    m.undo = { at: this.now(), turn, items: undoItems, dropped };
    m.checkpoints = m.checkpoints.filter((c) => c.turn < turn);
    this.save(sessionId);
    try {
      this.apply(plan.items.map((it) => ({ abs: it.abs, blob: it.target })));
    } catch (error) {
      this.undoRestore(sessionId); // leaves the workspace as it was before the attempt
      throw error;
    }
    return {
      written: plan.items.filter((i) => i.action === "write").length,
      deleted: plan.items.filter((i) => i.action === "delete").length,
      skipped: plan.skipped,
    };
  }

  /** Reverts the last restore, including the checkpoints it dropped. */
  undoRestore(sessionId: string): RestoreResult | undefined {
    const m = this.load(sessionId);
    const undo = m.undo;
    if (!undo) return undefined;
    this.apply(undo.items.map((it) => ({ abs: path.join(this.cwd, ...it.path.split("/")), blob: it.prev })));
    m.checkpoints = [...m.checkpoints, ...undo.dropped].sort((a, b) => a.turn - b.turn);
    m.undo = undefined;
    this.save(sessionId);
    return {
      written: undo.items.filter((i) => i.prev !== null).length,
      deleted: undo.items.filter((i) => i.prev === null).length,
      skipped: [],
    };
  }

  // ---- housekeeping -------------------------------------------------------------------------

  /** Deletes the checkpoints of sessions untouched for `maxAgeMs`, then blobs nothing refers to. Returns sessions removed. */
  prune(maxAgeMs: number): number {
    if (!existsSync(this.root)) return 0;
    let removed = 0;
    for (const name of readdirSync(this.root)) {
      if (name === BLOB_DIR) continue;
      const dir = path.join(this.root, name);
      try {
        const manifest = path.join(dir, "manifest.json");
        const touched = (existsSync(manifest) ? statSync(manifest) : statSync(dir)).mtimeMs;
        if (this.now() - touched > maxAgeMs) {
          rmSync(dir, { recursive: true, force: true });
          for (const id of [...this.cache.keys()]) if (this.sessionDir(id) === dir) this.cache.delete(id);
          removed++;
        }
      } catch {
        // a folder that cannot be inspected is left alone
      }
    }
    this.collectBlobs();
    return removed;
  }

  private collectBlobs(): void {
    const referenced = new Set<string>();
    for (const name of readdirSync(this.root)) {
      if (name === BLOB_DIR) continue;
      try {
        const m = JSON.parse(readFileSync(path.join(this.root, name, "manifest.json"), "utf8")) as Manifest;
        const all = [...m.checkpoints, ...(m.undo?.dropped ?? [])];
        for (const cp of all) for (const f of cp.files) if (f.before) referenced.add(f.before);
        for (const it of m.undo?.items ?? []) if (it.prev) referenced.add(it.prev);
      } catch {
        return; // cannot tell what is in use: keep every blob
      }
    }
    const dir = this.blobDir();
    if (!existsSync(dir)) return;
    for (const sha of readdirSync(dir)) if (!referenced.has(sha)) rmSync(path.join(dir, sha), { force: true });
  }

  // ---- internals ----------------------------------------------------------------------------

  private key(rel: string): string {
    return this.caseInsensitive ? rel.toLowerCase() : rel;
  }

  private sameKey(a: string, b: string): boolean {
    return this.key(a) === this.key(b);
  }

  /** Workspace-relative path with forward slashes, or undefined for anything outside the workspace. */
  private relative(abs: string): string | undefined {
    const rel = path.relative(this.cwd, abs);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
    return rel.split(path.sep).join("/");
  }

  private checkpoint(m: Manifest, turn: number, label: string): Checkpoint {
    let cp = m.checkpoints.find((c) => c.turn === turn);
    if (!cp) {
      cp = { turn, at: this.now(), label: label.slice(0, 120), files: [] };
      m.checkpoints.push(cp);
      m.checkpoints.sort((a, b) => a.turn - b.turn);
    } else if (label && !cp.label) {
      cp.label = label.slice(0, 120);
    }
    return cp;
  }

  private sessionDir(sessionId: string): string {
    return path.join(this.root, sessionId.replace(/[^A-Za-z0-9._-]/g, "_"));
  }

  private load(sessionId: string): Manifest {
    const cached = this.cache.get(sessionId);
    if (cached) return cached;
    let m: Manifest = { v: 1, sessionId, checkpoints: [] };
    try {
      const parsed = JSON.parse(readFileSync(path.join(this.sessionDir(sessionId), "manifest.json"), "utf8")) as Manifest;
      if (parsed?.v === 1 && Array.isArray(parsed.checkpoints)) m = parsed;
    } catch {
      // first use, or an unreadable manifest: start empty rather than blocking the agent
    }
    this.cache.set(sessionId, m);
    return m;
  }

  private save(sessionId: string): void {
    const m = this.load(sessionId);
    const dir = this.sessionDir(sessionId);
    mkdirSync(dir, { recursive: true });
    this.writeAtomic(path.join(dir, "manifest.json"), JSON.stringify(m));
  }

  private snapshot(abs: string, store: boolean): Snapshot {
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      return { kind: "absent" };
    }
    if (stat.isDirectory()) return { kind: "dir" };
    if (stat.size > this.maxBytes) return { kind: "too-large" };
    const data = readFileSync(abs);
    const sha = sha256(data);
    if (store) this.putBlob(sha, data);
    return { kind: "file", sha };
  }

  /** Content hash of what is on disk now: sha, null for absent, "unknown" when it cannot be compared. */
  private hashCurrent(abs: string): string | null | "unknown" {
    const snap = this.snapshot(abs, false);
    if (snap.kind === "absent") return null;
    if (snap.kind === "file") return snap.sha;
    return "unknown";
  }

  // Blobs are shared by every session of this workspace: the same file content is stored once.
  private blobDir(): string {
    return path.join(this.root, BLOB_DIR);
  }

  private putBlob(sha: string, data: Buffer): void {
    const target = path.join(this.blobDir(), sha);
    if (existsSync(target)) return;
    this.writeAtomic(target, data);
  }

  /** Saves what is on disk now (for undo). Returns its hash, or null when the file is absent. */
  private storeBlob(abs: string): string | null {
    const snap = this.snapshot(abs, true);
    if (snap.kind === "file") return snap.sha;
    if (snap.kind === "too-large") throw new Error(`File too large to back up before restoring: ${abs}`);
    return null;
  }

  private apply(items: { abs: string; blob: string | null }[]): void {
    for (const { abs, blob } of items) {
      if (blob === null) {
        rmSync(abs, { force: true });
      } else {
        this.writeAtomic(abs, readFileSync(path.join(this.blobDir(), blob)));
      }
    }
  }

  private writeAtomic(target: string, data: Buffer | string): void {
    mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.hermes-${process.pid}.tmp`;
    writeFileSync(tmp, data);
    renameSync(tmp, target);
  }
}
