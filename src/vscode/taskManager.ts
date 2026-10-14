// Parallel agent tasks (phase 6): each task is its own `hermes acp` process working in its own git worktree, so several
// agents can run at once without disturbing each other or the user's files. Nobody watches a task, so what it may do
// is decided by taskPolicy: edits inside its worktree are free, everything else is refused and listed. When it ends,
// its work is committed on its own branch and offered as a patch to review, apply or discard.
import { realpathSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type * as acp from "@agentclientprotocol/sdk";
import { AcpClient } from "../core/acpClient";
import type { CommandAllowlist } from "../core/commandPolicy";
import { cancelled, parsePermission, pickOption, selected } from "../core/permission";
import { decideTaskPermission, type DenyReason } from "../core/taskPolicy";
import { Transcript, transcriptToMarkdown } from "../core/transcript";
import {
  applyPatch, branchFor, commitTask, createWorktree, headCommit, newTaskId, removeTask, repoRoot, taskPatch,
} from "../core/worktree";
import type { HostToView, TaskStatus, TasksPanel, TaskView } from "../shared/protocol";
import { t, type Locale, type StringKey } from "../shared/strings";
import type { AgentLog } from "./agentLog";

const RECORDS_KEY = "hermes.tasks";
const DEFAULT_MAX_PARALLEL = 3;
const KEEP_NAMES = 30;
const KEEP_DENIED = 10;

interface TaskRecord {
  id: string;
  title: string;
  prompt: string;
  branch: string;
  dir: string;
  /** Where the agent works: the worktree, or the matching sub-folder of it when the project is a sub-folder of the repo. */
  cwd: string;
  root: string;
  base: string;
  status: TaskStatus;
  createdAt: number;
  finishedAt?: number;
  allowCommands: boolean;
  files: string[];
  fileCount: number;
  additions: number;
  deletions: number;
  summary?: string;
  error?: string;
  denied: { reason: DenyReason; subject: string }[];
  deniedCount: number;
  applied: boolean;
}

export interface TaskHost {
  locale(): Locale;
  /** Sends a message to every open panel. */
  post(msg: HostToView): void;
  cwd(): string | undefined;
  hermesPath(): string | undefined;
  /** The environment a Hermes for this workspace is launched with, with the terminal-approval hook forced on. */
  launchEnv(): Promise<NodeJS.ProcessEnv>;
  /** Already translated: why tasks cannot start (privacy block, hook not active), or undefined. */
  blockedReason(): string | undefined;
  allowlist(): CommandAllowlist;
  privacy(): { localOnly: boolean; allowedHosts: string[] };
  clientVersion(): string;
  notifyDone(detail: string, durationMs: number): void;
}

interface Running {
  client?: AcpClient;
  sessionId?: string;
  transcript: Transcript;
  stopRequested: boolean;
}

export class TaskManager implements vscode.Disposable {
  private records: TaskRecord[];
  private readonly running = new Map<string, Running>();
  private readonly transcripts = new Map<string, Transcript>();
  private notice: TasksPanel["notice"];
  private confirmOverride: ((message: string, detail: string | undefined) => Promise<boolean>) | undefined;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: AgentLog,
    private readonly host: TaskHost,
  ) {
    // A task that was running when the IDE closed has lost its agent; its worktree is still there to review or discard.
    this.records = (context.workspaceState.get<TaskRecord[]>(RECORDS_KEY) ?? []).map((r) =>
      r.status === "starting" || r.status === "running" ? { ...r, status: "interrupted" as const, finishedAt: r.finishedAt ?? Date.now() } : r,
    );
  }

  private tr(key: StringKey, ...args: (string | number)[]): string {
    return t(this.host.locale(), key, ...args);
  }

  private get storageDir(): string {
    return path.join(this.context.globalStorageUri.fsPath, "worktrees");
  }

  private maxParallel(): number {
    const v = vscode.workspace.getConfiguration("hermes.tasks").get<number>("maxParallel", DEFAULT_MAX_PARALLEL);
    return Number.isFinite(v) ? Math.min(Math.max(Math.round(v), 1), 6) : DEFAULT_MAX_PARALLEL;
  }

  // ---- view ---------------------------------------------------------------------------------

  view(): TasksPanel {
    const blocked = this.host.blockedReason();
    return {
      tasks: this.records.slice().reverse().map((r) => this.toView(r)),
      maxParallel: this.maxParallel(),
      ...(blocked ? { blocked } : {}),
      ...(this.notice ? { notice: this.notice } : {}),
    };
  }

  /** Where a task's worktree is (tests look into it). */
  directoryOf(id: string): string | undefined {
    return this.find(id)?.dir;
  }

  /** Task views for tests and for the panel. */
  views(): TaskView[] {
    return this.records.map((r) => this.toView(r));
  }

  private toView(r: TaskRecord): TaskView {
    const transcript = this.running.get(r.id)?.transcript ?? this.transcripts.get(r.id);
    let activity: string | undefined;
    if (r.status === "running" && transcript) {
      const tool = transcript.all().slice().reverse().find((i) => i.kind === "tool");
      if (tool && tool.kind === "tool" && tool.status !== "completed" && tool.status !== "failed") activity = tool.title;
    }
    return {
      id: r.id, title: r.title, status: r.status, branch: r.branch, createdAt: r.createdAt, finishedAt: r.finishedAt,
      allowCommands: r.allowCommands, files: r.files.slice(0, KEEP_NAMES), fileCount: r.fileCount, additions: r.additions, deletions: r.deletions,
      summary: r.summary, activity, denied: r.denied, deniedCount: r.deniedCount, error: r.error, applied: r.applied, hasChat: !!transcript,
    };
  }

  publish(notice?: TasksPanel["notice"]): void {
    if (notice !== undefined) this.notice = notice;
    this.host.post({ type: "tasks", panel: this.view() });
  }

  private publishSoon(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.publish();
    }, 250);
  }

  private async save(): Promise<void> {
    await this.context.workspaceState.update(RECORDS_KEY, this.records);
  }

  // ---- start --------------------------------------------------------------------------------

  async start(prompt: string, allowCommands: boolean): Promise<void> {
    const text = prompt.trim();
    if (!text) return;
    this.notice = undefined;
    const fail = (key: StringKey, ...args: (string | number)[]) => this.publish({ level: "error", text: this.tr(key, ...args) });

    const blocked = this.host.blockedReason();
    if (blocked) return fail("tasks.startFailed", blocked);
    const cwd = this.host.cwd();
    const hermes = this.host.hermesPath();
    if (!cwd) return fail("tasks.noWorkspace");
    if (!hermes) return fail("tasks.noHermes");
    if (!vscode.workspace.isTrusted) return fail("tasks.untrusted");
    const active = this.records.filter((r) => r.status === "starting" || r.status === "running").length;
    if (active >= this.maxParallel()) return fail("tasks.limit", this.maxParallel());

    const found = await repoRoot(cwd);
    if (!found) return fail("tasks.noGit");
    // Compare real paths: the workspace may be given as a short (8.3) or differently cased path that git, Hermes and
    // the task policy would each spell differently.
    const root = canonical(found);
    const realCwd = canonical(cwd);
    const base = await headCommit(root);
    if (!base) return fail("tasks.noCommit");

    const id = newTaskId();
    const branch = branchFor(id);
    const planned = path.join(this.storageDir, `${path.basename(root)}-${id}`);
    const created = await createWorktree(root, planned, branch, base);
    if (!created.ok) return fail("tasks.createFailed", created.error ?? "?");
    const dir = canonical(planned);

    const rel = path.relative(root, realCwd);
    const inside = rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
    const record: TaskRecord = {
      id, title: titleOf(text), prompt: text, branch, dir, cwd: inside ? path.join(dir, rel) : dir, root, base, status: "starting",
      createdAt: Date.now(), allowCommands, files: [], fileCount: 0, additions: 0, deletions: 0, denied: [], deniedCount: 0, applied: false,
    };
    this.records.push(record);
    await this.save();
    this.publish();
    this.log.info(`task ${id}: started on ${branch} in ${dir}`);
    void this.run(record);
  }

  /** Runs the agent to the end of its turn, then commits what it did. Never throws. */
  private async run(record: TaskRecord): Promise<void> {
    const state: Running = { transcript: new Transcript(), stopRequested: false };
    this.running.set(record.id, state);
    this.transcripts.set(record.id, state.transcript);
    let outcome: "done" | "failed" | "stopped" = "done";
    try {
      const hermes = this.host.hermesPath()!;
      const env = await this.host.launchEnv();
      const client = await AcpClient.start(
        { command: hermes, cwd: record.cwd, env },
        {
          onSessionUpdate: (n) => {
            if (n.sessionId !== state.sessionId) return;
            state.transcript.apply(n.update);
            this.publishSoon();
          },
          onPermission: (req) => this.onPermission(record, req),
          onLog: (line) => this.log.hermes(`[task ${record.id}] ${line}`),
          onExit: () => undefined,
        },
        { name: "hermes-ide-task", version: this.host.clientVersion() },
      );
      state.client = client;
      const method = (client.init?.authMethods ?? []).find((m) => !("type" in m && m.type === "terminal"));
      const authed = method ? await client.authenticate(method.id).catch(() => null) : null;
      if (!authed) throw new Error("Hermes has no configured provider");
      const session = await client.newSession(record.cwd, []);
      state.sessionId = session.sessionId;
      await client.setMode(session.sessionId, "default").catch(() => undefined);
      if (state.stopRequested) throw new StopError();

      record.status = "running";
      await this.save();
      this.publish();
      state.transcript.addUser(record.prompt);
      const brief = this.tr("tasks.agentBrief", record.cwd, record.branch);
      const res = await client.prompt(session.sessionId, [{ type: "text", text: `${brief}\n\n${record.prompt}` }]);
      if (res.stopReason === "cancelled" || state.stopRequested) outcome = "stopped";
    } catch (error) {
      if (error instanceof StopError || state.stopRequested) outcome = "stopped";
      else {
        outcome = "failed";
        record.error = (error as Error).message;
        this.log.info(`task ${record.id}: failed: ${record.error}`);
      }
    } finally {
      state.transcript.endTurn();
      await state.client?.stop().catch(() => undefined);
      this.running.delete(record.id);
    }

    try {
      const changes = await commitTask(record.dir, record.base, `hermes task: ${record.title}`);
      record.files = changes.files;
      record.fileCount = changes.files.length;
      record.additions = changes.additions;
      record.deletions = changes.deletions;
    } catch (error) {
      this.log.info(`task ${record.id}: could not summarise changes: ${(error as Error).message}`);
    }
    const lastAnswer = state.transcript.all().slice().reverse().find((i) => i.kind === "agent" && i.text.trim());
    if (lastAnswer && lastAnswer.kind === "agent") record.summary = lastAnswer.text.trim().slice(0, 800);
    record.status = outcome;
    record.finishedAt = Date.now();
    await this.save();
    this.publish();
    this.log.info(`task ${record.id}: ${outcome}, ${record.fileCount} files`);
    if (outcome === "done") this.host.notifyDone(record.title, record.finishedAt - record.createdAt);
  }

  private async onPermission(record: TaskRecord, req: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const parsed = parsePermission(req);
    const privacy = this.host.privacy();
    const decision = decideTaskPermission(parsed, {
      worktree: record.dir, allowCommands: record.allowCommands, allowlist: this.host.allowlist(), localOnly: privacy.localOnly, allowedHosts: privacy.allowedHosts,
    });
    if (decision.allow) return selected(pickOption(req.options, "allow_once"));
    record.deniedCount++;
    record.denied = [...record.denied, { reason: decision.reason, subject: decision.subject.slice(0, 200) }].slice(-KEEP_DENIED);
    this.log.info(`task ${record.id}: denied ${decision.reason}: ${decision.subject.slice(0, 120)}`);
    this.publishSoon();
    const reject = pickOption(req.options, "reject");
    return reject ? selected(reject) : cancelled();
  }

  // ---- actions ------------------------------------------------------------------------------

  private find(id: string): TaskRecord | undefined {
    return this.records.find((r) => r.id === id);
  }

  async stop(id: string): Promise<void> {
    const run = this.running.get(id);
    if (!run) return;
    run.stopRequested = true;
    if (run.client && run.sessionId) run.client.cancel(run.sessionId);
    // A task still starting has no session to cancel yet; its start sequence checks the flag.
    else await run.client?.stop().catch(() => undefined);
  }

  async viewChanges(id: string): Promise<void> {
    const record = this.find(id);
    if (!record) return;
    const patch = await taskPatch(record.dir, record.base);
    const doc = await vscode.workspace.openTextDocument({ language: "diff", content: patch || `# ${this.tr("tasks.noChanges")}\n` });
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  async openChat(id: string): Promise<void> {
    const record = this.find(id);
    const transcript = this.running.get(id)?.transcript ?? this.transcripts.get(id);
    if (!record || !transcript) return;
    const doc = await vscode.workspace.openTextDocument({ language: "markdown", content: transcriptToMarkdown(transcript.all(), record.title) });
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  async openFolder(id: string): Promise<void> {
    const record = this.find(id);
    if (record) await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(record.dir), { forceNewWindow: true });
  }

  /** Test hook: answers the confirmation dialogs without showing them. */
  setConfirm(answer: ((message: string, detail: string | undefined) => Promise<boolean>) | undefined): void {
    this.confirmOverride = answer;
  }

  private async confirm(message: string, detail: string | undefined): Promise<boolean> {
    const yes = this.tr("tasks.confirmYes");
    if (this.confirmOverride) return this.confirmOverride(message, detail);
    return (await vscode.window.showWarningMessage(message, { modal: true, ...(detail ? { detail } : {}) }, yes)) === yes;
  }

  async apply(id: string): Promise<void> {
    const record = this.find(id);
    if (!record || this.running.has(id)) return;
    if (record.fileCount === 0) return this.publish({ level: "error", text: this.tr("tasks.nothingToApply") });
    if (!(await this.confirm(this.tr("tasks.confirmApply", record.fileCount, record.title), this.tr("tasks.confirmApplyDetail")))) return;
    const patch = await taskPatch(record.dir, record.base);
    const result = await applyPatch(record.root, patch);
    this.log.info(`task ${id}: apply -> ${result.ok ? "ok" : result.error}`);
    if (result.ok) {
      record.applied = true;
      await this.save();
      this.publish({ level: "ok", text: this.tr("tasks.appliedOk", record.title) });
    } else {
      this.publish({ level: "error", text: this.tr("tasks.applyFailed", result.error ?? "?", record.branch) });
    }
  }

  async discard(id: string): Promise<void> {
    const record = this.find(id);
    if (!record) return;
    if (!(await this.confirm(this.tr("tasks.confirmDiscard", record.title), this.tr("tasks.confirmDiscardDetail", record.branch)))) return;
    await this.stop(id);
    // Wait for the agent to be gone so it is not writing into a folder that is being deleted.
    for (let i = 0; i < 100 && this.running.has(id); i++) await new Promise((r) => setTimeout(r, 100));
    await removeTask(record.root, record.dir, record.branch);
    this.records = this.records.filter((r) => r.id !== id);
    this.transcripts.delete(id);
    await this.save();
    this.publish({ level: "ok", text: this.tr("tasks.discarded", record.title) });
  }

  dispose(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    for (const run of this.running.values()) {
      run.stopRequested = true;
      void run.client?.stop().catch(() => undefined);
    }
  }
}

class StopError extends Error {}

/** The real, fully expanded path (falls back to the path itself when it cannot be resolved). */
function canonical(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return path.normalize(p);
  }
}

function titleOf(prompt: string): string {
  const line = prompt.split(/\r?\n/).find((l) => l.trim()) ?? prompt;
  return line.trim().length > 60 ? `${line.trim().slice(0, 57)}…` : line.trim();
}
