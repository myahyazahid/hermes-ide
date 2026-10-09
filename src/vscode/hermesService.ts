// Orchestrates one Hermes ACP process for the workspace: lifecycle (F-01..F-03, F-11), the chat
// transcript (F-06, F-07), permission cards (F-08), diff review (F-09), Stop (F-10), endpoint
// profiles and the Custom API page (F-04, F-05, F-16), context mentions (F-12), inline edits
// (F-13), session history (F-14) and MCP servers (F-15). Views only render what this publishes.
import { execFile } from "node:child_process";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import type * as acp from "@agentclientprotocol/sdk";
import { AcpClient, type HermesModelState } from "../core/acpClient";
import { CommandAllowlist, dangerousReason, normalizeCommand } from "../core/commandPolicy";
import { testConnection } from "../core/connectionTest";
import { buildPromptBlocks, contextLabel, decodeFile, MAX_FILE_BYTES, type FileContent } from "../core/context";
import {
  buildLaunchEnv, buildProfileConfigYaml, defaultHermesHome, readHermesModelConfig, shortModelName, validateCustomEndpoint,
  type CustomEndpoint,
} from "../core/endpoint";
import { isSupportedVersion, locateHermes, needsShell, readHermesVersion, SUPPORTED_HERMES } from "../core/hermesLocator";
import { applyHunks, computeHunks, diffStat, sameText } from "../core/hunks";
import { embed } from "../core/embeddings";
import { requestFim, type FimTemplate } from "../core/fim";
import { sanitizeMcpServers, toAcpMcpServers, validateMcpServer, type McpServerSetting } from "../core/mcp";
import type { McpHttpServer } from "../core/mcpHttpServer";
import { cancelled, parsePermission, pickOption, selected, type ParsedPermission } from "../core/permission";
import { parseProviderError, providerErrorKind } from "../core/providerError";
import { HERMES_PROFILE_ID, toEndpoint } from "../core/profiles";
import { Transcript } from "../core/transcript";
import type {
  ContextRef, HostToView, McpServerView, MentionItem, ModelOption, PermissionAction, TerminalApprovalState, TranscriptItem, ViewState,
  ViewToHost,
} from "../shared/protocol";
import { resolveLocale, t, type Locale, type StringKey } from "../shared/strings";
import type { AgentLog } from "./agentLog";
import type { DiffReviewManager } from "./diffReview";
import { INDEX_SECRET, type CodebaseIndex } from "./codebaseIndex";
import { FileIndex } from "./fileIndex";
import { ProfileStore } from "./profileStore";
import type { SessionSummary } from "./sessionsView";
import { COMPLETION_SECRET, type TabCompletion } from "./tabCompletion";
import { TerminalApprovalSetup } from "./terminalApprovalSetup";

const ALLOWLIST_KEY = "hermes.allowlist";
const PREFERRED_MODEL_KEY = "hermes.preferredModel";
const LAST_SESSION_KEY = "hermes.lastSessionId";
const HIDDEN_SESSIONS_KEY = "hermes.hiddenSessions";
/** How long a command approved on the hook card also answers Hermes' own danger check for it. */
const HOOK_APPROVAL_TTL_MS = 120_000;

interface PendingPermission {
  itemId: string;
  sessionId: string;
  parsed: ParsedPermission;
  options: acp.PermissionOption[];
  respond(response: acp.RequestPermissionResponse): void;
  reviewId?: string;
  absPath?: string;
}

/** Phase 3 features that live outside Hermes. */
export interface IdeFeatures {
  completion: TabCompletion;
  index: CodebaseIndex;
  /** Serves IDE tools (codebase_search) to Hermes over MCP. */
  mcp: McpHttpServer;
}

export interface InlineEditRequest {
  path: string;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  text: string;
  languageId: string;
  instruction: string;
}

export class HermesService implements vscode.Disposable {
  private client: AcpClient | undefined;
  private hermesPath: string | undefined;
  private launchEnvironment: NodeJS.ProcessEnv | undefined;
  private starting: Promise<boolean> | undefined;
  private transcript = new Transcript();
  private readonly pending = new Map<string, PendingPermission>();
  private readonly notesForNextPrompt: string[] = [];
  private readonly hookApprovals = new Map<string, number>();
  private readonly inlineReplies = new Map<string, string>();
  private readonly reportedErrors = new Set<string>();
  private suppressUpdates = false;
  private seq = 0;
  private post: ((msg: HostToView) => void) | undefined;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private availableModels: HermesModelState["availableModels"] = [];
  private readonly stateChanged = new vscode.EventEmitter<ViewState>();
  private readonly sessionsChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeState = this.stateChanged.event;
  readonly onDidChangeSessions = this.sessionsChanged.event;
  private readonly disposables: vscode.Disposable[] = [this.stateChanged, this.sessionsChanged];
  readonly profiles: ProfileStore;
  private readonly approval: TerminalApprovalSetup;
  private readonly files: FileIndex;
  state: ViewState;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: AgentLog,
    private readonly reviews: DiffReviewManager,
    private readonly features: IdeFeatures,
  ) {
    this.profiles = new ProfileStore(context.secrets);
    this.approval = new TerminalApprovalSetup(context, log);
    this.files = new FileIndex(() => this.cwd);
    this.state = {
      phase: "checking",
      busy: false,
      models: [],
      endpoint: { activeProfileId: HERMES_PROFILE_ID, profiles: [] },
      test: { running: false },
      terminalApproval: "disabled",
      mcpServers: [],
      completion: features.completion.view(),
      index: features.index.view(),
    };
    this.disposables.push(
      features.completion.onDidChange(() => this.setState({ completion: features.completion.view() })),
      features.index.onDidChange(() => this.setState({ index: features.index.view() })),
      vscode.workspace.onDidGrantWorkspaceTrust(() => void this.refresh()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.restartForWorkspaceChange()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("hermes.path")) void this.restartForWorkspaceChange();
        else if (e.affectsConfiguration("hermes.language")) this.sendInit();
        else if (e.affectsConfiguration("hermes.profiles") || e.affectsConfiguration("hermes.mcpServers")) void this.loadSettingsView();
      }),
    );
  }

  get locale(): Locale {
    return resolveLocale(vscode.workspace.getConfiguration("hermes").get<string>("language"), vscode.env.language);
  }

  private tr(key: StringKey, ...args: (string | number)[]): string {
    return t(this.locale, key, ...args);
  }

  /** Snapshot of the chat transcript (used by tests and for debugging). */
  transcriptItems(): TranscriptItem[] {
    return this.transcript.all();
  }

  get processId(): number | undefined {
    return this.client?.pid;
  }

  get currentSessionId(): string | undefined {
    return this.state.sessionId;
  }

  get busy(): boolean {
    return this.state.busy;
  }

  private get cwd(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  // ---- view wiring --------------------------------------------------------------------------

  attachView(post: (msg: HostToView) => void): vscode.Disposable {
    this.post = post;
    return new vscode.Disposable(() => {
      if (this.post === post) this.post = undefined;
    });
  }

  async handleViewMessage(msg: ViewToHost): Promise<void> {
    switch (msg.type) {
      case "ready":
        this.sendInit();
        // F-01: Hermes starts when the panel opens.
        if (this.state.phase === "stopped") void this.ensureStarted();
        return;
      case "send":
        return this.send(msg.text, msg.context ?? []);
      case "stop":
        return this.stop();
      case "newSession":
        return this.newSession();
      case "permission":
        return this.handlePermissionAction(msg.id, msg.action);
      case "selectModel":
        return this.selectModel(msg.modelId);
      case "mentionQuery": {
        const items: MentionItem[] = await this.files.search(msg.query).catch(() => []);
        if (this.features.index.enabled && "codebase".startsWith(msg.query.toLowerCase())) {
          items.unshift({ kind: "codebase", path: "", label: "codebase" });
        }
        this.post?.({ type: "mentionResults", requestId: msg.requestId, items });
        return;
      }
      case "selectProfile":
        return this.selectProfile(msg.id);
      case "saveProfile":
        return this.saveProfile(msg);
      case "deleteProfile":
        return this.deleteProfile(msg.id);
      case "testEndpoint":
        return this.testEndpoint(msg);
      case "enableTerminalApproval":
        return this.enableTerminalApproval();
      case "dismissTerminalApproval":
        await this.approval.dismiss();
        this.setState({ terminalApproval: "dismissed" });
        return;
      case "saveMcpServers":
        return this.saveMcpServers(msg.servers);
      case "saveCompletion":
        return this.saveCompletion(msg);
      case "testCompletion":
        return this.testCompletion(msg);
      case "saveIndex":
        return this.saveIndex(msg);
      case "testIndex":
        return this.testIndex(msg);
      case "rebuildIndex":
        return this.features.index.rebuild();
      case "restart":
        return this.restart();
      case "recheck":
        return this.refresh();
      case "openFile":
        await vscode.window.showTextDocument(vscode.Uri.file(msg.path), { preview: true });
        return;
      case "showLog":
        this.log.show(false);
        return;
      case "trustWorkspace":
        await vscode.commands.executeCommand("workbench.trust.manage");
        return;
    }
  }

  /** Adds a context chip to the composer (selection command, explorer "Add to chat"). */
  addContext(ref: ContextRef): void {
    this.post?.({ type: "addContext", ref });
  }

  private sendInit(): void {
    this.post?.({ type: "init", locale: this.locale, state: this.state, items: this.transcript.all() });
  }

  private setState(patch: Partial<ViewState>): void {
    this.state = { ...this.state, ...patch };
    this.post?.({ type: "state", state: this.state });
    this.stateChanged.fire(this.state);
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      const items = this.transcript.takeChanges();
      if (items.length) this.post?.({ type: "items", items });
    }, 40);
  }

  private notice(level: "info" | "warn" | "error", text: string): void {
    this.transcript.addNotice(level, text);
    this.scheduleFlush();
  }

  // ---- lifecycle ----------------------------------------------------------------------------

  /** Re-evaluates preconditions (trust, folder, binary, endpoint); starts Hermes if the panel is open. */
  async refresh(autoStart = true): Promise<void> {
    await this.profiles.migrateLegacy().catch((e: Error) => this.log.info(`profile migration failed: ${e.message}`));
    await this.loadSettingsView();
    if (!vscode.workspace.isTrusted) return this.setState({ phase: "untrusted", phaseDetail: undefined });
    if (!this.cwd) return this.setState({ phase: "noWorkspace", phaseDetail: undefined, cwd: undefined });
    this.setState({ cwd: this.cwd });

    this.setState({ phase: "checking", phaseDetail: undefined });
    const configured = vscode.workspace.getConfiguration("hermes").get<string>("path");
    this.hermesPath = locateHermes({ configuredPath: configured });
    if (!this.hermesPath) {
      this.log.info(`hermes not found (hermes.path=${configured || "<unset>"})`);
      return this.setState({ phase: "missing" });
    }
    try {
      const version = await readHermesVersion(this.hermesPath);
      this.setState({
        hermesVersion: version,
        versionWarning: isSupportedVersion(version)
          ? undefined
          : this.tr("banner.version", version, `>=${SUPPORTED_HERMES.min} <${SUPPORTED_HERMES.maxExclusive}`),
      });
      this.log.info(`hermes ${version} at ${this.hermesPath}`);
    } catch (error) {
      this.log.info(`could not read hermes version: ${(error as Error).message}`);
    }

    const profile = this.profiles.active();
    if (profile && validateCustomEndpoint(toEndpoint(profile))) {
      return this.setState({ phase: "needsSetup", phaseDetail: undefined });
    }
    if (!profile) this.setState({ terminalApproval: await this.approval.hermesConfigState() });
    this.setState({ phase: this.client?.isAlive ? "ready" : "stopped" });
    if (autoStart && this.post && !this.client) void this.ensureStarted();
  }

  ensureStarted(): Promise<boolean> {
    if (this.client?.isAlive && this.state.sessionId) return Promise.resolve(true);
    if (this.state.phase !== "stopped" && this.state.phase !== "crashed" && this.state.phase !== "starting") {
      return Promise.resolve(false);
    }
    this.starting ??= this.start().finally(() => (this.starting = undefined));
    return this.starting;
  }

  private async start(resumeSessionId?: string): Promise<boolean> {
    const cwd = this.cwd;
    if (!cwd || !this.hermesPath) return false;
    this.setState({ phase: "starting", phaseDetail: undefined });
    const profile = this.profiles.active();
    try {
      const { env, approval } = await this.launchEnv();
      this.launchEnvironment = env;
      this.setState({ terminalApproval: approval });
      const client = await AcpClient.start(
        { command: this.hermesPath, cwd, env },
        {
          onSessionUpdate: (n) => this.onSessionUpdate(n),
          onPermission: (req) => this.onPermission(req),
          onLog: (line) => {
            this.log.hermes(line);
            this.onHermesLogLine(line);
          },
          onExit: (info) => this.onExit(client, info),
        },
        { name: "hermes-ide", version: String(this.context.extension.packageJSON.version ?? "0.0.0") },
      );
      this.client = client;
      this.log.info(`hermes acp started (pid ${client.pid}, profile ${profile?.id ?? HERMES_PROFILE_ID}, cwd ${cwd}, terminal approval ${approval})`);

      const method = (client.init?.authMethods ?? []).find((m) => !("type" in m && m.type === "terminal"));
      const authed = method ? await client.authenticate(method.id).catch(() => null) : null;
      if (!authed) {
        this.log.info("hermes has no configured provider (authenticate failed)");
        await client.stop();
        this.client = undefined;
        this.setState({ phase: "needsSetup", phaseDetail: profile ? undefined : this.tr("banner.notConfigured") });
        return false;
      }

      let models: HermesModelState | null | undefined;
      let sessionId: string | undefined;
      if (resumeSessionId) {
        this.suppressUpdates = true; // the transcript is still in memory; skip Hermes' replay
        try {
          const loaded = await client.loadSession(cwd, resumeSessionId, await this.mcpServersForSession());
          if (loaded) {
            sessionId = resumeSessionId;
            models = loaded.models;
          }
        } catch (error) {
          this.log.info(`session/load failed: ${(error as Error).message}`);
        } finally {
          this.suppressUpdates = false;
        }
      }
      if (!sessionId) {
        const created = await client.newSession(cwd, await this.mcpServersForSession());
        sessionId = created.sessionId;
        models = created.models;
        if (resumeSessionId) this.resetTranscript();
      }
      await this.context.workspaceState.update(LAST_SESSION_KEY, sessionId);
      await this.pinAskMode(client, sessionId);
      this.applyModels(models);
      this.setState({ phase: "ready", sessionId, busy: false });
      await this.applyPreferredModel();
      this.sessionsChanged.fire();
      return true;
    } catch (error) {
      const message = (error as Error).message;
      this.log.info(`start failed: ${message}`);
      await this.client?.stop();
      this.client = undefined;
      this.setState({ phase: "crashed", phaseDetail: message });
      this.notice("error", this.tr("notice.startFailed", message));
      return false;
    }
  }

  private onExit(client: AcpClient, info: { code: number | null; signal: NodeJS.Signals | null; expected: boolean }): void {
    this.log.info(`hermes exited (code ${info.code}, signal ${info.signal ?? "-"}, expected ${info.expected})`);
    if (this.client !== client) return;
    this.client = undefined;
    this.cancelPending();
    this.transcript.endTurn();
    this.scheduleFlush();
    this.sessionsChanged.fire();
    if (info.expected) {
      this.setState({ phase: "stopped", busy: false });
      return;
    }
    this.setState({ phase: "crashed", busy: false, phaseDetail: `exit code ${info.code ?? info.signal ?? "?"}` });
    this.notice("error", this.tr("banner.crashed"));
  }

  /** Restarts the process without reloading the window and resumes the current session. */
  async restart(): Promise<void> {
    const sessionId = this.state.sessionId;
    await this.shutdown();
    await this.refresh(false);
    if (this.state.phase !== "stopped") return;
    this.starting = this.start(sessionId).finally(() => (this.starting = undefined));
    if ((await this.starting) && sessionId && this.state.sessionId === sessionId) {
      this.notice("info", this.tr("notice.restarted"));
    }
  }

  /** Endpoint changed: the old session belongs to another Hermes home or provider, so start clean. */
  private async restartFresh(): Promise<void> {
    await this.shutdown();
    this.resetTranscript();
    this.setState({ sessionId: undefined, models: [], currentModelId: undefined, usage: undefined, sessionTitle: undefined });
    await this.refresh();
  }

  private async restartForWorkspaceChange(): Promise<void> {
    await this.restartFresh();
  }

  async shutdown(): Promise<void> {
    const client = this.client;
    this.cancelPending();
    if (client) {
      if (this.state.busy && this.state.sessionId) client.cancel(this.state.sessionId);
      await client.stop();
    }
    this.client = undefined;
    this.transcript.endTurn();
    this.scheduleFlush();
    this.setState({ phase: "stopped", busy: false });
  }

  // ---- conversation -------------------------------------------------------------------------

  async send(text: string, context: ContextRef[] = []): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || this.state.busy) return;
    if (!(await this.ensureStarted()) || !this.client || !this.state.sessionId) return;

    const cwd = this.cwd;
    this.reportedErrors.clear();
    this.transcript.addUser(trimmed, context.map((c) => ({ label: contextLabel(c, cwd), path: c.path })));
    this.scheduleFlush();
    const notes = this.notesForNextPrompt.splice(0);
    const body = notes.length ? `${notes.join("\n")}\n\n${trimmed}` : trimmed;
    if (context.some((c) => c.kind === "folder")) await this.files.ensure();
    const expanded = await this.expandCodebase(trimmed, context);
    const blocks = buildPromptBlocks(body, expanded, { cwd, folderListing: (f) => this.files.listFolder(f), readFile: readContextFile });
    this.setState({ busy: true });
    this.sessionsChanged.fire();
    const client = this.client;
    try {
      const res = await client.prompt(this.state.sessionId, blocks);
      if (res.stopReason === "cancelled") this.notice("info", this.tr("notice.stopped"));
      else if (res.stopReason === "refusal") this.notice("warn", "refusal");
    } catch (error) {
      if (client.isAlive) this.notice("error", this.tr("notice.promptFailed", (error as Error).message));
    } finally {
      this.transcript.endTurn();
      this.scheduleFlush();
      this.setState({ busy: false });
      this.sessionsChanged.fire();
    }
  }

  /** @codebase: replaces the reference with the best-matching chunks for the prompt (F-18). */
  private async expandCodebase(query: string, context: ContextRef[]): Promise<ContextRef[]> {
    if (!context.some((c) => c.kind === "codebase")) return context;
    const rest = context.filter((c) => c.kind !== "codebase");
    if (!this.features.index.ready || !this.cwd) {
      this.notice("warn", this.tr("index.notReady"));
      return rest;
    }
    try {
      const hits = await this.features.index.search(query, 8);
      const cwd = this.cwd;
      return [...rest, ...hits.map((h): ContextRef => ({
        kind: "selection", path: path.join(cwd, h.path), startLine: h.startLine, endLine: h.endLine, text: h.text,
      }))];
    } catch (error) {
      this.notice("warn", this.tr("index.searchFailed", (error as Error).message));
      return rest;
    }
  }

  /** F-10: cancels the running turn; ACP requires pending permission requests to be cancelled too. */
  async stop(): Promise<void> {
    if (!this.client || !this.state.sessionId || !this.state.busy) return;
    this.client.cancel(this.state.sessionId);
    this.cancelPending(this.state.sessionId);
  }

  async newSession(): Promise<void> {
    if (this.state.busy) await this.stop();
    if (!(await this.ensureStarted()) || !this.client) return;
    try {
      const created = await this.client.newSession(this.cwd!, await this.mcpServersForSession());
      await this.context.workspaceState.update(LAST_SESSION_KEY, created.sessionId);
      await this.pinAskMode(this.client, created.sessionId);
      this.notesForNextPrompt.length = 0;
      this.resetTranscript();
      this.applyModels(created.models);
      this.setState({ sessionId: created.sessionId, sessionTitle: undefined, usage: undefined });
      await this.applyPreferredModel();
      this.sessionsChanged.fire();
    } catch (error) {
      this.notice("error", this.tr("notice.promptFailed", (error as Error).message));
    }
  }

  /**
   * Hermes persists a per-session edit policy (Zed exposes "Accept Edits"/"Don't Ask"); a session
   * resumed from such a client would skip our diff review, so every session is pinned to "default".
   */
  private async pinAskMode(client: AcpClient, sessionId: string): Promise<void> {
    await client.setMode(sessionId, "default").catch((e: Error) => this.log.info(`session/set_mode failed: ${e.message}`));
  }

  private resetTranscript(): void {
    this.transcript = new Transcript();
    this.post?.({ type: "reset", items: [] });
  }

  async selectModel(modelId: string): Promise<void> {
    if (!this.client || !this.state.sessionId || this.state.busy) return;
    try {
      await this.client.setModel(this.state.sessionId, modelId);
      this.setState({ currentModelId: modelId });
      if (!this.profiles.active()) await this.context.globalState.update(PREFERRED_MODEL_KEY, modelId);
    } catch (error) {
      this.notice("error", this.tr("notice.modelFailed", (error as Error).message));
    }
  }

  private applyModels(models: HermesModelState | null | undefined): void {
    this.availableModels = models?.availableModels ?? [];
    const shortCounts = new Map<string, number>();
    for (const m of this.availableModels) {
      const s = shortModelName(m.modelId, this.availableModels);
      shortCounts.set(s, (shortCounts.get(s) ?? 0) + 1);
    }
    const options: ModelOption[] = this.availableModels.map((m) => {
      const s = shortModelName(m.modelId, this.availableModels);
      return { id: m.modelId, label: (shortCounts.get(s) ?? 0) > 1 ? m.name : s, group: modelGroup(m.modelId, m.name) };
    });
    const current = models?.currentModelId;
    if (current && !options.some((o) => o.id === current)) {
      options.unshift({ id: current, label: shortModelName(current, this.availableModels), group: modelGroup(current, "") });
    }
    this.setState({ models: options, currentModelId: current });
  }

  /** Profile "hermes": re-applies the model the user last picked (e.g. customer-service). */
  private async applyPreferredModel(): Promise<void> {
    if (this.profiles.active()) return;
    const preferred = this.context.globalState.get<string>(PREFERRED_MODEL_KEY);
    if (!preferred || preferred === this.state.currentModelId) return;
    if (!this.availableModels.some((m) => m.modelId === preferred)) return;
    await this.selectModel(preferred);
  }

  private onSessionUpdate(n: acp.SessionNotification): void {
    if (this.inlineReplies.has(n.sessionId)) {
      const u = n.update;
      if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text") {
        this.inlineReplies.set(n.sessionId, this.inlineReplies.get(n.sessionId)! + u.content.text);
      }
      return;
    }
    if (this.suppressUpdates || n.sessionId !== this.state.sessionId) return;
    const effects = this.transcript.apply(n.update);
    if (effects.usage) this.setState({ usage: effects.usage });
    if (effects.title) {
      this.setState({ sessionTitle: effects.title });
      this.sessionsChanged.fire();
    }
    this.scheduleFlush();
  }

  /** Hermes only tells ACP clients "retrying API call after error"; the reason is in its log. */
  private onHermesLogLine(line: string): void {
    if (!line.includes("Error code:")) return;
    const err = parseProviderError(line);
    if (!err) return;
    const key = `${err.status}|${err.message}`;
    if (this.reportedErrors.has(key)) return;
    this.reportedErrors.add(key);
    const kind = providerErrorKind(err.status);
    const model = err.model ? ` (${err.model})` : "";
    this.notice("error", this.tr("notice.providerError", err.status, err.message + model) + " " + this.tr(`providerHint.${kind}` as StringKey));
  }

  // ---- sessions (F-14) ----------------------------------------------------------------------

  async listSessions(): Promise<SessionSummary[]> {
    if (!this.client?.isAlive || !this.cwd) return [];
    const hidden = new Set(this.context.workspaceState.get<string[]>(HIDDEN_SESSIONS_KEY) ?? []);
    const sessions = await this.client.listSessions(this.cwd);
    const out = sessions
      .filter((s) => !hidden.has(s.sessionId))
      .map((s) => ({ id: s.sessionId, title: s.title ?? "", updatedAt: s.updatedAt ?? undefined }));
    // The current session has no history until its first prompt, but belongs in the list.
    const current = this.state.sessionId;
    if (current && !out.some((s) => s.id === current)) {
      out.unshift({ id: current, title: this.state.sessionTitle ?? this.tr("sessions.new"), updatedAt: new Date().toISOString() });
    }
    return out;
  }

  /** Resumes a session from history: Hermes replays it into a fresh transcript. */
  async openSession(sessionId: string): Promise<void> {
    if (sessionId === this.state.sessionId) return;
    if (this.state.busy) await this.stop();
    if (!(await this.ensureStarted()) || !this.client || !this.cwd) return;
    this.cancelPending();
    this.notesForNextPrompt.length = 0;
    this.resetTranscript();
    const previous = this.state.sessionId;
    // Set before loading so the replayed updates pass the session filter.
    this.setState({ sessionId, sessionTitle: undefined, usage: undefined });
    try {
      const loaded = await this.client.loadSession(this.cwd, sessionId, await this.mcpServersForSession());
      if (!loaded) throw new Error("session not found");
      await this.pinAskMode(this.client, sessionId);
      this.applyModels(loaded.models);
      this.transcript.endTurn();
      this.scheduleFlush();
      await this.context.workspaceState.update(LAST_SESSION_KEY, sessionId);
    } catch (error) {
      this.setState({ sessionId: previous });
      this.notice("error", this.tr("notice.sessionOpenFailed", (error as Error).message));
    }
    this.sessionsChanged.fire();
  }

  async deleteSession(sessionId: string): Promise<void> {
    if (!this.hermesPath) return;
    if (sessionId === this.state.sessionId) await this.newSession();
    await this.hideSession(sessionId);
    const command = this.hermesPath;
    const shell = needsShell(command);
    await new Promise<void>((resolve) => {
      execFile(shell ? `"${command}"` : command, ["sessions", "delete", sessionId, "--yes"],
        { env: this.launchEnvironment ?? process.env, windowsHide: true, shell, timeout: 60_000 },
        (error, _stdout, stderr) => {
          if (error) this.log.info(`hermes sessions delete ${sessionId} failed: ${stderr || error.message}`);
          else this.log.info(`session ${sessionId} deleted`);
          resolve();
        });
    });
    this.sessionsChanged.fire();
  }

  private async hideSession(sessionId: string): Promise<void> {
    const hidden = this.context.workspaceState.get<string[]>(HIDDEN_SESSIONS_KEY) ?? [];
    if (!hidden.includes(sessionId)) {
      await this.context.workspaceState.update(HIDDEN_SESSIONS_KEY, [...hidden, sessionId].slice(-500));
    }
  }

  // ---- inline edit (F-13) -------------------------------------------------------------------

  /**
   * Runs one inline edit in its own short-lived Hermes session so the chat history stays clean.
   * The proposed change arrives as a normal edit permission and opens as a diff in place of the
   * editor. Resolves with Hermes' reply text.
   */
  async inlineEdit(req: InlineEditRequest, token: vscode.CancellationToken): Promise<string> {
    if (!(await this.ensureStarted()) || !this.client || !this.cwd) throw new Error(this.tr("inline.notReady"));
    const client = this.client;
    const created = await client.newSession(this.cwd, await this.mcpServersForSession());
    const sessionId = created.sessionId;
    await this.hideSession(sessionId);
    this.inlineReplies.set(sessionId, "");
    await this.pinAskMode(client, sessionId);
    if (this.state.currentModelId && created.models?.currentModelId !== this.state.currentModelId) {
      await client.setModel(sessionId, this.state.currentModelId).catch(() => {});
    }
    const cancel = token.onCancellationRequested(() => {
      client.cancel(sessionId);
      this.cancelPending(sessionId);
    });
    const rel = path.relative(this.cwd, req.path).split(path.sep).join("/");
    const fence = "`".repeat(Math.max(3, ...[...req.text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
    const prompt = [
      "Inline edit requested from the editor.",
      `File: ${rel} (absolute path: ${req.path})`,
      `Lines ${req.startLine}-${req.endLine} currently contain:`,
      `${fence}${req.languageId}`,
      req.text,
      fence,
      `Instruction: ${req.instruction}`,
      "Rules: change only those lines of this file, using the patch tool (mode replace). Do not edit other files and do not run commands. When done, reply with one short sentence.",
    ].join("\n");
    try {
      await client.prompt(sessionId, [{ type: "text", text: prompt }]);
      return this.inlineReplies.get(sessionId) ?? "";
    } finally {
      cancel.dispose();
      this.inlineReplies.delete(sessionId);
    }
  }

  // ---- permissions (F-08, F-09) -------------------------------------------------------------

  private onPermission(req: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const parsed = parsePermission(req);
    const itemId = `perm:${++this.seq}`;
    this.log.info(`permission request ${itemId}: ${parsed.variant}${parsed.variant === "execute" && parsed.viaHook ? " (hook)" : ""} ${JSON.stringify(req.options.map((o) => o.optionId))}`);

    return new Promise((resolve) => {
      let settled = false;
      const respond = (response: acp.RequestPermissionResponse) => {
        if (settled) return;
        settled = true;
        this.pending.delete(itemId);
        resolve(response);
      };
      const entry: PendingPermission = { itemId, sessionId: req.sessionId, parsed, options: req.options, respond };

      if (parsed.variant === "execute") {
        const key = normalizeCommand(parsed.command);
        // Hermes' own danger check fires after our hook for risky commands: the user already
        // answered the hook card, so don't ask twice.
        if (!parsed.viaHook && (this.hookApprovals.get(key) ?? 0) > Date.now()) {
          this.hookApprovals.delete(key);
          respond(selected(pickOption(req.options, "allow_once")));
          return;
        }
        const danger = dangerousReason(parsed.command);
        const title = parsed.tool === "execute_code" ? this.tr("perm.executeCode") : this.tr("perm.execute");
        const base = { kind: "permission" as const, id: itemId, variant: "execute" as const, title, command: parsed.command };
        if (!danger && parsed.tool !== "execute_code" && this.allowlist().allows(parsed.command)) {
          this.transcript.upsert({ ...base, actions: [], state: "allowed", resolution: this.tr("perm.autoAllowed") });
          this.scheduleFlush();
          if (parsed.viaHook) this.hookApprovals.set(key, Date.now() + HOOK_APPROVAL_TTL_MS);
          respond(selected(pickOption(req.options, "allow_once")));
          return;
        }
        const actions: PermissionAction[] = danger || parsed.tool === "execute_code"
          ? ["allow_once", "reject"]
          : ["allow_once", "allow_always_ws", "reject"];
        this.transcript.upsert({
          ...base, actions, state: "pending", dangerReason: danger ? this.tr("perm.dangerous", danger) : undefined,
        });
      } else if (parsed.variant === "edit") {
        this.startEditReview(entry, parsed);
      } else {
        this.transcript.upsert({
          kind: "permission", id: itemId, variant: "other", title: req.toolCall.title ?? this.tr("perm.other"),
          actions: ["allow_once", "reject"], state: "pending",
        });
      }
      this.pending.set(itemId, entry);
      this.scheduleFlush();
    });
  }

  private startEditReview(entry: PendingPermission, parsed: Extract<ParsedPermission, { variant: "edit" }>): void {
    const cwd = this.cwd ?? "";
    const absPath = path.isAbsolute(parsed.path) ? parsed.path : path.join(cwd, parsed.path);
    const outside = parsed.paths.some((p) => !isInside(cwd, path.isAbsolute(p) ? p : path.join(cwd, p)));
    const dirty = vscode.workspace.textDocuments.some((d) => d.isDirty && samePath(d.uri.fsPath, absPath));
    const stat = parsed.isPatch ? undefined : diffStat(parsed.oldText ?? "", parsed.newText);
    const warnings = [outside ? this.tr("perm.outside") : "", dirty ? this.tr("perm.dirty") : ""].filter(Boolean);
    entry.reviewId = `r${this.seq}`;
    entry.absPath = absPath;

    this.transcript.upsert({
      kind: "permission", id: entry.itemId, variant: "edit",
      title: parsed.isPatch && parsed.paths.length > 1 ? this.tr("perm.editPatch", parsed.paths.length) : this.tr("perm.edit"),
      path: absPath, paths: parsed.paths, added: stat?.added, removed: stat?.removed,
      dangerReason: warnings.join(" ") || undefined, actions: ["review", "allow_once", "reject"], state: "pending",
    });

    void this.reviews
      .start({ id: entry.reviewId, path: absPath, oldText: parsed.oldText ?? "", newText: parsed.newText, isPatch: parsed.isPatch })
      .then((decision) => {
        if (decision.cancelled) return this.resolveCard(entry, cancelled(), "cancelled", this.tr("perm.cancelled"));
        if (!decision.accept) {
          return this.resolveCard(entry, selected(pickOption(entry.options, "reject")), "rejected", this.tr("perm.rejected"));
        }
        const partial = !parsed.isPatch && decision.acceptedHunks.length < decision.totalHunks;
        this.resolveCard(
          entry, selected(pickOption(entry.options, "allow_once")), "allowed",
          partial ? this.tr("perm.partial", decision.acceptedHunks.length, decision.totalHunks) : this.tr("perm.allowed"),
        );
        if (partial) void this.revertRejectedHunks(absPath, parsed.oldText ?? "", parsed.newText, decision.acceptedHunks, decision.totalHunks);
      });
  }

  private async handlePermissionAction(itemId: string, action: PermissionAction): Promise<void> {
    const entry = this.pending.get(itemId);
    if (!entry) return;
    if (entry.reviewId) {
      if (action === "review") await this.reviews.show(entry.reviewId);
      else this.reviews.decide(entry.reviewId, action !== "reject");
      return;
    }
    const allowed = (resolution: string, choice: "allow_once" | "allow_session" = "allow_once") => {
      if (entry.parsed.variant === "execute" && entry.parsed.viaHook) {
        this.hookApprovals.set(normalizeCommand(entry.parsed.command), Date.now() + HOOK_APPROVAL_TTL_MS);
      }
      this.resolveCard(entry, selected(pickOption(entry.options, choice)), "allowed", resolution);
    };
    switch (action) {
      case "allow_once":
        return allowed(this.tr("perm.allowed"));
      case "allow_session":
        return allowed(this.tr("perm.allowedSession"), "allow_session");
      case "allow_always_ws": {
        // Stored per workspace by the IDE; Hermes only gets allow_once so its global allowlist is untouched.
        if (entry.parsed.variant === "execute") {
          const list = this.allowlist();
          if (list.add(entry.parsed.command)) await this.context.workspaceState.update(ALLOWLIST_KEY, list.toJSON());
        }
        return allowed(this.tr("perm.allowedAlways"));
      }
      case "reject":
        return this.resolveCard(entry, selected(pickOption(entry.options, "reject")), "rejected", this.tr("perm.rejected"));
    }
  }

  private resolveCard(
    entry: PendingPermission, response: acp.RequestPermissionResponse,
    state: "allowed" | "rejected" | "cancelled", resolution: string,
  ): void {
    entry.respond(response);
    this.transcript.patch(entry.itemId, "permission", { state, resolution, actions: [] });
    this.scheduleFlush();
  }

  /** Cancels pending permission requests, for one session or all. */
  private cancelPending(sessionId?: string): void {
    for (const entry of [...this.pending.values()]) {
      if (sessionId && entry.sessionId !== sessionId) continue;
      if (entry.reviewId) this.reviews.cancel(entry.reviewId); // resolves the card via the review promise
      else this.resolveCard(entry, cancelled(), "cancelled", this.tr("perm.cancelled"));
    }
  }

  /** Keeps the diff-review card in sync when hunks are toggled in the editor. */
  onReviewSelectionChanged(reviewId: string, accepted: number, total: number): void {
    const entry = [...this.pending.values()].find((p) => p.reviewId === reviewId);
    if (!entry) return;
    const resolution = accepted === total ? undefined : this.tr("perm.partial", accepted, total);
    this.transcript.patch(entry.itemId, "permission", { resolution });
    this.scheduleFlush();
  }

  /**
   * Hermes writes the whole proposal once allowed; ACP has no way to approve part of it. So after
   * Hermes' write lands we put back the hunks the user rejected and tell the agent next turn.
   * Hermes can still refuse the write after approval (e.g. its stale-write guard on a file the
   * agent never read), so we stop watching once the turn is over.
   */
  private async revertRejectedHunks(absPath: string, oldText: string, newText: string, accepted: number[], total: number): Promise<void> {
    const rel = path.relative(this.cwd ?? "", absPath) || absPath;
    const target = applyHunks(computeHunks(oldText, newText), new Set(accepted));
    const hardDeadline = Date.now() + 120_000;
    let idleSince: number | undefined;
    while (Date.now() < hardDeadline) {
      const current = await readFile(absPath, "utf8").catch(() => undefined);
      if (current !== undefined && sameText(current, newText)) {
        try {
          await vscode.workspace.fs.writeFile(vscode.Uri.file(absPath), Buffer.from(target, "utf8"));
          this.notesForNextPrompt.push(this.tr("note.partial", rel, accepted.length, total));
          this.notice("info", this.tr("notice.partialApplied", rel));
        } catch (error) {
          this.notice("error", this.tr("notice.partialFailed", rel, (error as Error).message));
        }
        return;
      }
      if (!this.state.busy && !this.inlineReplies.size) {
        idleSince ??= Date.now();
        if (Date.now() - idleSince > 1500) break;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    // Nothing to revert: Hermes did not apply the edit (its tool card shows why) or the file moved on.
    this.log.info(`partial accept for ${rel}: proposed text never landed on disk; nothing reverted`);
  }

  private allowlist(): CommandAllowlist {
    return new CommandAllowlist(this.context.workspaceState.get<string[]>(ALLOWLIST_KEY) ?? []);
  }

  async manageAllowlist(): Promise<void> {
    const entries = this.allowlist().toJSON();
    if (!entries.length) {
      void vscode.window.showInformationMessage(this.tr("allowlist.empty"));
      return;
    }
    const picked = await vscode.window.showQuickPick(entries, { canPickMany: true, placeHolder: this.tr("allowlist.pick") });
    if (!picked?.length) return;
    const list = this.allowlist();
    for (const c of picked) list.remove(c);
    await this.context.workspaceState.update(ALLOWLIST_KEY, list.toJSON());
    void vscode.window.showInformationMessage(this.tr("allowlist.cleared"));
  }

  // ---- terminal approval (user story 4) -----------------------------------------------------

  private async enableTerminalApproval(): Promise<void> {
    try {
      await this.approval.enableInHermesConfig();
      this.notice("info", this.tr("notice.approvalEnabled"));
      await this.restart();
    } catch (error) {
      this.notice("error", this.tr("notice.approvalFailed", (error as Error).message));
    }
  }

  async removeTerminalApprovalHook(): Promise<void> {
    const removed = await this.approval.removeFromHermesConfig();
    void vscode.window.showInformationMessage(this.tr(removed ? "approval.removed" : "approval.notInstalled"));
    if (removed && !this.profiles.active()) await this.restart();
  }

  // ---- endpoint profiles (F-04, F-05, F-16) -------------------------------------------------

  private async loadSettingsView(): Promise<void> {
    this.log.setSecrets(await this.allSecrets());
    const configPath = path.join(defaultHermesHome(), "config.yaml");
    const hermesConfig = { ...readHermesModelConfig(await readFile(configPath, "utf8").catch(() => "")), path: configPath };
    this.setState({
      endpoint: {
        activeProfileId: this.profiles.activeId(),
        profiles: await this.profiles.views(this.tr("api.mode.hermes")),
        hermesConfig,
      },
      mcpServers: this.mcpSettings().map(toMcpView),
    });
  }

  private async launchEnv(): Promise<{ env: NodeJS.ProcessEnv; approval: TerminalApprovalState }> {
    const profile = this.profiles.active();
    if (!profile) {
      const approval = await this.approval.hermesConfigState();
      return { env: { ...buildLaunchEnv({ parentEnv: process.env, mode: "hermes" }), ...this.approval.env(approval) }, approval };
    }
    // All custom profiles share one IDE-owned Hermes home, so their sessions stay listed together.
    const custom = toEndpoint(profile, await this.profiles.key(profile.id));
    const profileHome = path.join(this.context.globalStorageUri.fsPath, "hermes-home");
    await mkdir(profileHome, { recursive: true });
    const configPath = path.join(profileHome, "config.yaml");
    const { yaml, state } = await this.approval.prepareProfile(profileHome, buildProfileConfigYaml(custom));
    if ((await readFile(configPath, "utf8").catch(() => "")) !== yaml) await writeFile(configPath, yaml, "utf8");
    const env = buildLaunchEnv({ parentEnv: process.env, mode: "custom", custom, profileHome });
    return { env: { ...env, ...this.approval.env(state) }, approval: state };
  }

  async selectProfile(id: string): Promise<void> {
    if (id === this.profiles.activeId()) return;
    await this.profiles.select(id);
    this.log.info(`profile switched to ${id}`);
    await this.restartFresh();
  }

  private async saveProfile(msg: Extract<ViewToHost, { type: "saveProfile" }>): Promise<void> {
    const invalid = validateCustomEndpoint({ baseUrl: msg.profile.baseUrl, model: msg.profile.model });
    if (invalid) {
      this.setState({ test: { running: false, ok: false, message: this.tr(`test.fail.${invalid}` as StringKey) } });
      return;
    }
    const id = await this.profiles.save(msg.profile, msg.apiKey);
    await this.profiles.select(id);
    this.log.info(`profile ${id} saved (base ${msg.profile.baseUrl}, model ${msg.profile.model})`);
    // Saving activates the profile; endpoint, key or model may have changed, so start clean.
    await this.restartFresh();
  }

  private async deleteProfile(id: string): Promise<void> {
    const wasActive = id === this.profiles.activeId();
    await this.profiles.delete(id);
    if (wasActive) await this.restartFresh();
    else await this.loadSettingsView();
  }

  private async testEndpoint(msg: Extract<ViewToHost, { type: "testEndpoint" }>): Promise<void> {
    this.setState({ test: { running: true } });
    if (!msg.baseUrl.trim()) {
      // Profile "hermes": check that Hermes itself can open a session with its own config.
      const ok = await this.ensureStarted();
      if (!ok || !this.client) {
        this.setState({ test: { running: false, ok: false, message: this.state.phaseDetail ?? this.tr("status.crashed") } });
        return;
      }
      const t0 = Date.now();
      try {
        const probe = await this.client.newSession(this.cwd!);
        await this.hideSession(probe.sessionId);
        const label = shortModelName(this.state.currentModelId, this.availableModels) || this.tr("composer.noModel");
        this.setState({ test: { running: false, ok: true, message: this.tr("test.hermesOk", label, Date.now() - t0) } });
      } catch (error) {
        this.setState({ test: { running: false, ok: false, message: (error as Error).message } });
      }
      return;
    }

    const stored = msg.profileId ? await this.profiles.key(msg.profileId) : undefined;
    const apiKey = msg.apiKey !== undefined && msg.apiKey !== "" ? msg.apiKey : stored;
    const ep: CustomEndpoint = { baseUrl: msg.baseUrl, model: msg.model, apiKey, contextLength: msg.contextLength };
    const invalid = validateCustomEndpoint(ep);
    if (invalid) {
      this.setState({ test: { running: false, ok: false, message: this.tr(`test.fail.${invalid}` as StringKey) } });
      return;
    }
    const result = await testConnection(ep);
    this.log.info(`connection test: ${JSON.stringify({ ...result, detail: result.detail?.slice(0, 200) })}`);
    const extras = [
      result.contextLength ? this.tr("test.context", result.contextLength) : this.tr("test.contextUnknown"),
      result.modelNotListed ? this.tr("test.modelNotListed") : "",
    ].filter(Boolean);
    if (result.ok) {
      const tool = this.tr(result.toolUse === "supported" ? "test.toolSupported" : "test.toolUnknown");
      this.setState({ test: { running: false, ok: true, message: this.tr("test.ok", result.latencyMs ?? 0, tool), detail: extras.join(" · ") } });
    } else {
      const reason = this.tr(`test.fail.${result.problem ?? "other"}` as StringKey);
      this.setState({ test: { running: false, ok: false, message: reason, detail: result.detail } });
    }
  }

  // ---- MCP servers (F-15) -------------------------------------------------------------------

  private mcpSettings(): McpServerSetting[] {
    return sanitizeMcpServers(vscode.workspace.getConfiguration("hermes").get("mcpServers"));
  }

  /** User MCP servers plus the IDE's own (codebase_search) when the index is enabled. */
  private async mcpServersForSession(): Promise<acp.McpServer[]> {
    const servers = toAcpMcpServers(this.mcpSettings());
    if (!this.features.index.enabled) return servers;
    try {
      const url = await this.features.mcp.start();
      servers.push({ type: "http", name: "hermes-ide", url, headers: [{ name: "Authorization", value: `Bearer ${this.features.mcp.token}` }] });
    } catch (error) {
      this.log.info(`IDE MCP server failed to start: ${(error as Error).message}`);
    }
    return servers;
  }

  private async saveMcpServers(views: McpServerView[]): Promise<void> {
    const existing = new Map(this.mcpSettings().map((s) => [s.name, s]));
    // env/headers may hold tokens and never travel to the webview; keep them from settings by name.
    const next: McpServerSetting[] = views.map((v) => ({
      name: v.name.trim(),
      type: v.type,
      command: v.type === "stdio" ? v.command?.trim() : undefined,
      args: v.type === "stdio" ? v.args : undefined,
      url: v.type === "stdio" ? undefined : v.url?.trim(),
      env: existing.get(v.name)?.env,
      headers: existing.get(v.name)?.headers,
      enabled: v.enabled,
    }));
    for (const s of next) {
      const problem = validateMcpServer(s, next);
      if (problem) {
        this.setState({ mcpError: `${s.name || "?"}: ${this.tr(problem as StringKey)}` });
        return;
      }
    }
    const compact = next.map((s) => Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined)));
    await vscode.workspace.getConfiguration("hermes").update("mcpServers", compact, vscode.ConfigurationTarget.Global);
    this.setState({ mcpError: undefined, mcpServers: next.map(toMcpView) });
    this.log.info(`MCP servers saved: ${next.map((s) => `${s.name}${s.enabled === false ? " (off)" : ""}`).join(", ") || "-"}`);
    // MCP servers are attached when a session is created or loaded: resume the session with them.
    if (this.client) await this.restart();
  }

  // ---- Tab autocomplete (F-17) and codebase index (F-18) ------------------------------------

  private async saveCompletion(msg: Extract<ViewToHost, { type: "saveCompletion" }>): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("hermes.completion");
    const target = vscode.ConfigurationTarget.Global;
    await cfg.update("enabled", msg.enabled, target);
    await cfg.update("baseUrl", msg.baseUrl.trim(), target);
    await cfg.update("model", msg.model.trim(), target);
    await cfg.update("template", msg.template, target);
    if (msg.apiKey !== undefined) {
      if (msg.apiKey === "") await this.context.secrets.delete(COMPLETION_SECRET);
      else await this.context.secrets.store(COMPLETION_SECRET, msg.apiKey.trim());
    }
    await this.features.completion.reloadKey();
    this.log.setSecrets(await this.allSecrets());
    this.setState({ completion: this.features.completion.view() });
  }

  private async testCompletion(msg: Extract<ViewToHost, { type: "testCompletion" }>): Promise<void> {
    this.setState({ completionTest: { running: true } });
    const apiKey = msg.apiKey || (await this.context.secrets.get(COMPLETION_SECRET));
    try {
      const result = await requestFim(
        { baseUrl: msg.baseUrl, model: msg.model, apiKey, template: msg.template as FimTemplate, maxTokens: 32 },
        "function add(a: number, b: number): number {\n  return ",
        "\n}\n",
        { multiline: false, timeoutMs: 15_000 },
      );
      this.setState({ completionTest: { running: false, ok: true, message: this.tr("completion.testOk", result.latencyMs), detail: result.text || this.tr("completion.empty") } });
    } catch (error) {
      this.setState({ completionTest: { running: false, ok: false, message: this.tr("completion.testFailed"), detail: (error as Error).message } });
    }
  }

  private async saveIndex(msg: Extract<ViewToHost, { type: "saveIndex" }>): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("hermes.index");
    const target = vscode.ConfigurationTarget.Global;
    const wasEnabled = this.features.index.enabled;
    await cfg.update("enabled", msg.enabled, target);
    await cfg.update("baseUrl", msg.baseUrl.trim(), target);
    await cfg.update("model", msg.model.trim(), target);
    if (msg.apiKey !== undefined) {
      if (msg.apiKey === "") await this.context.secrets.delete(INDEX_SECRET);
      else await this.context.secrets.store(INDEX_SECRET, msg.apiKey.trim());
    }
    this.log.setSecrets(await this.allSecrets());
    await this.features.index.reconfigure();
    // The IDE MCP server (codebase_search) is attached per session: resume with or without it.
    if (wasEnabled !== msg.enabled && this.client) await this.restart();
  }

  private async testIndex(msg: Extract<ViewToHost, { type: "testIndex" }>): Promise<void> {
    this.setState({ indexTest: { running: true } });
    const apiKey = msg.apiKey || (await this.context.secrets.get(INDEX_SECRET));
    const t0 = Date.now();
    try {
      const [v] = await embed({ baseUrl: msg.baseUrl, model: msg.model, apiKey }, ["function login(user, password)"], { timeoutMs: 20_000 });
      this.setState({ indexTest: { running: false, ok: true, message: this.tr("index.testOk", Date.now() - t0, v.length) } });
    } catch (error) {
      this.setState({ indexTest: { running: false, ok: false, message: this.tr("index.testFailed"), detail: (error as Error).message } });
    }
  }

  private async allSecrets(): Promise<string[]> {
    const extra = await Promise.all([this.context.secrets.get(COMPLETION_SECRET), this.context.secrets.get(INDEX_SECRET)]);
    return [...(await this.profiles.allKeys()), ...extra.filter((k): k is string => !!k)];
  }

  dispose(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    void this.shutdown();
    for (const d of this.disposables) d.dispose();
  }
}

/** Reads an @file for embedding (at most MAX_FILE_BYTES; the prompt is assembled synchronously). */
function readContextFile(file: string): FileContent {
  try {
    const size = statSync(file).size;
    const buffer = Buffer.alloc(Math.min(size, MAX_FILE_BYTES + 1));
    const fd = openSync(file, "r");
    try {
      readSync(fd, buffer, 0, buffer.length, 0);
    } finally {
      closeSync(fd);
    }
    return decodeFile(file, buffer, size);
  } catch (error) {
    return { kind: "error", message: (error as Error).message };
  }
}

/** "Anthropic · claude-x" → "Anthropic"; "custom:router.example.com:m" → "router.example.com". */
function modelGroup(modelId: string, name: string): string {
  if (name.includes(" · ")) return name.split(" · ")[0];
  const custom = /^custom:([^:]+\.[^:]+):/.exec(modelId);
  if (custom) return custom[1];
  const i = modelId.indexOf(":");
  return i > 0 ? modelId.slice(0, i) : "";
}

function toMcpView(s: McpServerSetting): McpServerView {
  return { name: s.name, type: s.type, command: s.command, args: s.args, url: s.url, enabled: s.enabled !== false };
}

function isInside(root: string, target: string): boolean {
  if (!root) return false;
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => path.resolve(p);
  return process.platform === "win32" ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}
