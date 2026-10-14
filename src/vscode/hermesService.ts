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
  buildLaunchEnv, buildProfileConfigYaml, defaultHermesHome, readHermesModelConfig, resolveModelId, shortModelName, validateCustomEndpoint,
  type CustomEndpoint,
} from "../core/endpoint";
import { isSupportedVersion, locateHermes, needsShell, readHermesVersion, SUPPORTED_HERMES } from "../core/hermesLocator";
import { versionStatus } from "../core/hermesMaintenance";
import { evaluatePrivacy, networkCommandReason, scanHermesConfig, type ConfigEndpoint, type PrivacyReport } from "../core/privacy";
import { effectiveAgentLanguage, languageNote, learningNote, parseAgentLanguage, parseLearningLevel } from "../core/agentNotes";
import { listEndpointModels } from "../core/endpointModels";
import { isPresetUrl } from "../shared/presets";
import { isStackId, stackInfo } from "../shared/stacks";
import { HOOK_ENV } from "../core/terminalApproval";
import { loadMemory, memoryPath, saveMemory as saveMemoryFile } from "../core/memory";
import { inspectSkill, installSkill, listInstalledSkills, searchSkills, uninstallSkill, type SkillsContext } from "../core/skills";
import { privacyReportMarkdown } from "../core/privacyReport";
import { classifyPrompt, modelForTier, parseRoutingSettings, worthFallback, type RoutingSettings } from "../core/routing";
import { RULES_REMOVED_NOTE, STEER_NOTE, rulesNote } from "../core/rules";
import { fromAcpUsage } from "../core/usage";
import { applyHunks, computeHunks, diffStat, sameText } from "../core/hunks";
import { embed } from "../core/embeddings";
import { requestFim, type FimTemplate } from "../core/fim";
import { sanitizeMcpServers, toAcpMcpServers, validateMcpServer, type McpServerSetting } from "../core/mcp";
import type { McpHttpServer } from "../core/mcpHttpServer";
import { cancelled, parsePermission, pickOption, selected, type ParsedPermission } from "../core/permission";
import { parseProviderError, providerErrorKind } from "../core/providerError";
import { addCall, parseApiCallLine } from "../core/apiCallLog";
import { HERMES_PROFILE_ID, toEndpoint } from "../core/profiles";
import { parseSessionTime } from "../core/time";
import { Transcript, transcriptToMarkdown } from "../core/transcript";
import type {
  AgentMode, ContextRef, HostToView, LanguageView, LearningView, McpServerView, MentionItem, MemoryPanel, MemoryTarget, ModelOption, PermissionAction, RoutingView, SessionView, SkillsPanel, TerminalApprovalState, TranscriptItem, ViewState,
  ViewToHost,
} from "../shared/protocol";
import { resolveLocale, t, type Locale, type StringKey } from "../shared/strings";
import type { AgentLog } from "./agentLog";
import type { DiffReviewManager } from "./diffReview";
import { CheckpointManager } from "./checkpointManager";
import { INDEX_SECRET, type CodebaseIndex } from "./codebaseIndex";
import { FileIndex } from "./fileIndex";
import { HermesMaintenance } from "./hermesMaintenance";
import { DeployManager } from "./deployManager";
import { Notifier } from "./notifier";
import { StackTemplates } from "./stackTemplates";
import { TaskManager } from "./taskManager";
import { blockedByLocalMode, modelBlockedByLocalMode, privacySettings } from "./privacyGate";
import { ProjectRulesWatcher } from "./projectRules";
import { UsageTracker } from "./usageTracker";
import { ProfileStore } from "./profileStore";
import type { SessionSummary } from "./sessionsView";
import { COMPLETION_SECRET, type TabCompletion } from "./tabCompletion";
import { TerminalApprovalSetup } from "./terminalApprovalSetup";

const ALLOWLIST_KEY = "hermes.allowlist";
const PREFERRED_MODEL_KEY = "hermes.preferredModel";
const LAST_SESSION_KEY = "hermes.lastSessionId";
const MODE_KEY = "hermes.agentMode";
const LEARNING_KEY = "hermes.learningMode";
const MODES: readonly AgentMode[] = ["manual", "acceptEdits", "plan", "ask", "auto", "superAuto"];
const workspaceNote = (cwd: string) =>
  `[IDE] The user's project is the VS Code workspace at ${cwd}; relative paths resolve there. ` +
  "Create and edit the files you make for the user inside this workspace. The Hermes scratch directory is only for throwaway probes, never for deliverables.";
const NARRATE_NOTE =
  "[IDE] Before each tool call or group of tool calls, write one short sentence to the user saying what you are about to do and why, in the user's language. Keep it to one line; do not repeat it after the tool runs.";
const ASK_NOTE =
  "[Ask mode] Answer the question. This is read-only: you may read and search files, but do not edit files and do not run terminal commands or code.";
const PLAN_NOTE =
  "[Plan mode] Explore the code and answer with a concrete step-by-step plan. Do not edit files and do not run commands that change anything; the user will switch modes when they want the plan carried out.";
const HIDDEN_SESSIONS_KEY = "hermes.hiddenSessions";
const ONBOARDED_KEY = "hermes.onboarded";
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
  /** A restart in progress: a message sent meanwhile waits for it instead of being dropped. */
  private restarting: Promise<void> | undefined;
  private transcript = new Transcript();
  private readonly pending = new Map<string, PendingPermission>();
  private readonly notesForNextPrompt: string[] = [];
  /** Sessions that already got the workspace note (see send). */
  private readonly briefedSessions = new Set<string>();
  /** Sessions that already got the narrate-steps note. */
  private readonly narratedSessions = new Set<string>();
  private readonly hookApprovals = new Map<string, number>();
  private readonly inlineReplies = new Map<string, string>();
  private readonly reportedErrors = new Set<string>();
  private suppressUpdates = false;
  private seq = 0;
  /** Messages typed while a turn runs (see send). */
  private readonly queue: { id: string; text: string; context: ContextRef[]; steerId?: string }[] = [];
  /** send() is between its busy check and the turn showing as busy. */
  private turnStarting = false;
  /** "Send now" stopped the running turn: the queue goes out once it has ended. */
  private sendQueueAfterStop = false;
  /** Steers sent this turn that Hermes has not yet logged as delivered. */
  private readonly pendingSteers: { id: string; text: string }[] = [];
  /** Hermes answers each /steer with a "Steer queued" line; those stay out of the agent's reply. */
  private steerAcks = 0;
  /** Every open chat view: the sidebar one and, when opened, the one in an editor tab. */
  private readonly views = new Set<(msg: HostToView) => void>();
  /** The view the user touched last; context chips go there instead of to every composer. */
  private activeView: ((msg: HostToView) => void) | undefined;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  /** Everything the picker offers: what Hermes listed plus, for a custom endpoint, the other models it serves. */
  private availableModels: HermesModelState["availableModels"] = [];
  private hermesModels: HermesModelState["availableModels"] = [];
  private endpointModels: HermesModelState["availableModels"] = [];
  private readonly stateChanged = new vscode.EventEmitter<ViewState>();
  private readonly sessionsChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeState = this.stateChanged.event;
  readonly onDidChangeSessions = this.sessionsChanged.event;
  private readonly disposables: vscode.Disposable[] = [this.stateChanged, this.sessionsChanged];
  readonly profiles: ProfileStore;
  private readonly approval: TerminalApprovalSetup;
  private readonly files: FileIndex;
  private readonly usageTracker: UsageTracker;
  private readonly checkpoints: CheckpointManager;
  private readonly rules: ProjectRulesWatcher;
  private readonly notifier: Notifier;
  private readonly tasks: TaskManager;
  private readonly stackTemplates: StackTemplates;
  private readonly deploy: DeployManager;
  readonly maintenance: HermesMaintenance;
  /** Hash of the project rules last sent in each session, so they are sent once and again only when they change. */
  private readonly rulesSent = new Map<string, string>();
  /** Turn number (0-based user message count) of the running turn, the key for its checkpoint. -1 before the first. */
  private currentTurn = -1;
  private turnStartedAt = 0;
  private checkpointWarned = false;
  /** Endpoints Hermes may use on its own, found in the user's own config.yaml (judged by full local mode). */
  private hermesConfigEndpoints: ConfigEndpoint[] = [];
  private lastLocalOnly = privacySettings().localOnly;
  /** Sessions where the user picked a model by hand: routing leaves them alone until a new session. */
  private readonly routingPaused = new Set<string>();
  /** A model that just failed is not routed to again for a while. */
  private readonly modelCooldown = new Map<string, number>();
  private readonly warnedRoutingModels = new Set<string>();
  private skills: SkillsPanel = { installed: [], results: [] };
  /** The language the agent was last told to answer in, per session (so a change is sent once, not every prompt). */
  private readonly languageSent = new Map<string, string>();
  /** HTTP statuses of provider errors Hermes logged during the running turn (see onHermesLogLine). */
  private readonly turnProviderStatuses: number[] = [];
  /** Hermes logged that it gave up on the model for this turn (not merely a retry that later worked). */
  private turnGaveUp = false;
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
    this.usageTracker = new UsageTracker(context);
    this.checkpoints = new CheckpointManager(context, log, () => this.cwd);
    this.stackTemplates = new StackTemplates(context, () => this.cwd);
    this.deploy = new DeployManager(context, log, {
      locale: () => this.locale,
      post: (msg) => this.post?.(msg),
      terminalApproval: () => this.state.terminalApproval,
    });
    this.rules = new ProjectRulesWatcher(() => this.cwd, () => this.setState({ rules: this.rules.view(), stacks: this.stackTemplates.views() }));
    this.notifier = new Notifier(log, { locale: () => this.locale, openPanel: () => void vscode.commands.executeCommand("hermes.openChat") });
    this.tasks = new TaskManager(context, log, {
      locale: () => this.locale,
      post: (msg) => this.post?.(msg),
      cwd: () => this.cwd,
      hermesPath: () => this.hermesPath,
      // Tasks run unattended, so every terminal command must surface as a permission request for the task policy to judge.
      launchEnv: async () => ({ ...(await this.launchEnv()).env, [HOOK_ENV]: "1" }),
      blockedReason: () => this.tasksBlockedReason(),
      allowlist: () => this.allowlist(),
      privacy: () => privacySettings(),
      clientVersion: () => String(context.extension.packageJSON.version ?? "0.0.0"),
      notifyDone: (detail, ms) => void this.notifier.notify("done", detail, ms),
    });
    this.maintenance = new HermesMaintenance(context, log, {
      locale: () => this.locale,
      hermesPath: () => this.hermesPath,
      env: () => this.launchEnvironment,
      version: () => this.state.hermesVersion,
      busy: () => this.state.busy,
      stopHermes: () => this.shutdown(),
      refresh: () => this.refresh(),
      setUpdateStatus: (status) => this.setState({ hermesUpdate: status }),
      notice: (level, text) => this.notice(level, text),
    });
    this.state = {
      phase: "checking",
      mode: MODES.find((m) => m === context.workspaceState.get(MODE_KEY)) ?? "manual",
      busy: false,
      models: [],
      endpoint: { activeProfileId: HERMES_PROFILE_ID, profiles: [] },
      test: { running: false },
      terminalApproval: "disabled",
      mcpServers: [],
      completion: features.completion.view(),
      index: features.index.view(),
      rules: this.rules.view(),
      // New users only: someone who already chatted in this workspace does not need the quick-start card.
      onboarding: !context.globalState.get<boolean>(ONBOARDED_KEY) && !context.workspaceState.get<string>(LAST_SESSION_KEY),
      canInstallHermes: process.platform === "win32",
      routing: this.routingView(),
      language: this.languageView(),
      learning: this.learningView(),
      stacks: this.stackTemplates.views(),
    };
    this.disposables.push(this.rules, this.maintenance, this.tasks,
      features.completion.onDidChange(() => this.setState({ completion: features.completion.view() })),
      features.index.onDidChange(() => this.setState({ index: features.index.view() })),
      vscode.workspace.onDidGrantWorkspaceTrust(() => void this.refresh()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.restartForWorkspaceChange()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("hermes.path")) void this.restartForWorkspaceChange();
        else if (e.affectsConfiguration("hermes.language")) {
          this.setState({ language: this.languageView() });
          this.sendInit();
        }
        else if (e.affectsConfiguration("hermes.profiles") || e.affectsConfiguration("hermes.mcpServers")) void this.loadSettingsView();
        else if (e.affectsConfiguration("hermes.pricing") || e.affectsConfiguration("hermes.usage")) this.publishUsage();
        else if (e.affectsConfiguration("hermes.privacy")) void this.onPrivacyChanged();
        else if (e.affectsConfiguration("hermes.agentLanguage") || e.affectsConfiguration("hermes.learning")) {
          this.setState({ language: this.languageView(), learning: this.learningView() });
        } else if (e.affectsConfiguration("hermes.routing")) {
          this.routingPaused.clear();
          this.setState({ routing: this.routingView() });
        }
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
    this.views.add(post);
    this.activeView = post;
    return new vscode.Disposable(() => {
      this.views.delete(post);
      if (this.activeView === post) this.activeView = this.views.values().next().value;
    });
  }

  /** Transcript and state are shared, so they go to every open view; undefined when none is open. */
  private get post(): ((msg: HostToView) => void) | undefined {
    if (this.views.size === 0) return undefined;
    return (msg) => {
      for (const view of this.views) view(msg);
    };
  }

  /** `reply` is the view that sent the message: answers to its own requests must not reach the other view. */
  async handleViewMessage(msg: ViewToHost, reply?: (msg: HostToView) => void): Promise<void> {
    if (reply && this.views.has(reply)) this.activeView = reply;
    switch (msg.type) {
      case "ready":
        this.sendInit(reply);
        // F-01: Hermes starts when the panel opens.
        if (this.state.phase === "stopped") void this.ensureStarted();
        return;
      case "send":
        return this.send(msg.text, msg.context ?? []);
      case "stop":
        return this.stop();
      case "sendQueued":
        return this.sendQueued();
      case "unqueue": {
        const i = this.queue.findIndex((q) => q.id === msg.id);
        if (i < 0) return;
        const [item] = this.queue.splice(i, 1);
        this.publishQueue();
        // "Edit": the view puts the text back in the composer, its chips come from here.
        if (msg.edit) for (const ref of item.context) reply?.({ type: "addContext", ref });
        return;
      }
      case "newSession":
        return this.newSession();
      case "setMode":
        if (!MODES.includes(msg.mode)) return;
        this.setState({ mode: msg.mode });
        await this.context.workspaceState.update(MODE_KEY, msg.mode);
        return;
      case "attachFile": {
        const cwd = this.cwd;
        const picked = await vscode.window.showOpenDialog({ canSelectMany: true, defaultUri: cwd ? vscode.Uri.file(cwd) : undefined });
        for (const uri of picked ?? []) this.addContext({ kind: "file", path: uri.fsPath });
        return;
      }
      case "exportConversation": {
        const content = transcriptToMarkdown(this.transcript.all(), this.state.sessionTitle);
        const doc = await vscode.workspace.openTextDocument({ language: "markdown", content });
        await vscode.window.showTextDocument(doc, { preview: false });
        return;
      }
      case "listSessions":
        return this.postSessions(msg.requestId, reply);
      case "openSession":
        return this.openSession(msg.id, msg.title);
      case "deleteSession":
        await vscode.commands.executeCommand("hermes.sessions.delete", { id: msg.id, title: msg.title });
        return this.postSessions(msg.requestId, reply);
      case "permission":
        return this.handlePermissionAction(msg.id, msg.action);
      case "selectModel": {
        // Choosing a model yourself is an override: routing stays out of the way for the rest of this session.
        const sid = this.state.sessionId;
        if (sid && this.routingSettings().enabled && msg.modelId !== this.state.currentModelId && !this.routingPaused.has(sid)) {
          this.routingPaused.add(sid);
          this.notice("info", this.tr("routing.paused"));
        }
        return this.selectModel(msg.modelId);
      }
      case "saveRouting":
        return this.saveRouting(msg.routing);
      case "loadDeploy":
        return this.deploy.publish();
      case "saveDeployTarget":
        return this.deploy.save(msg.target, msg.original);
      case "deleteDeployTarget":
        return this.deploy.remove(msg.name);
      case "testDeployTarget":
        return this.deploy.test(msg.name);
      case "openSshTerminal":
        return this.deploy.openTerminal(msg.name);
      case "prepareDeploy": {
        if (this.state.terminalApproval !== "active") return this.deploy.publish({ level: "error", text: this.tr("deploy.needApproval") });
        const text = this.deploy.prompt(msg.name);
        if (text) {
          this.post?.({ type: "insertPrompt", text });
          this.deploy.publish({ level: "ok", text: this.tr("deploy.promptReady") });
        }
        return;
      }
      case "showDeployHistory":
        return this.deploy.showHistory();
      case "loadStacks":
        return this.setState({ stacks: this.stackTemplates.views() });
      case "addStackRules":
        return this.addStackRules(msg.id);
      case "dismissStack":
        if (isStackId(msg.id)) await this.stackTemplates.dismiss(msg.id);
        return this.setState({ stacks: this.stackTemplates.views() });
      case "listModels":
        return this.listModelsForForm(msg.baseUrl, msg.apiKey, msg.profileId);
      case "openUrl":
        if (isPresetUrl(msg.url)) await vscode.env.openExternal(vscode.Uri.parse(msg.url));
        return;
      case "setLanguage":
        return this.setLanguage(msg.ui, msg.agent);
      case "setLearning":
        return this.setLearning(msg.on, msg.level);
      case "loadMemory":
        return this.postMemory();
      case "saveMemory":
        return this.saveMemoryTarget(msg.target, msg.entries, msg.hash);
      case "openMemoryFile":
        return this.openMemoryFile(msg.target);
      case "loadTasks":
        return this.tasks.publish();
      case "startTask":
        return this.tasks.start(msg.prompt, msg.allowCommands);
      case "stopTask":
        return this.tasks.stop(msg.id);
      case "viewTaskChanges":
        return this.tasks.viewChanges(msg.id);
      case "openTaskChat":
        return this.tasks.openChat(msg.id);
      case "applyTask":
        return this.tasks.apply(msg.id);
      case "discardTask":
        return this.tasks.discard(msg.id);
      case "openTaskFolder":
        return this.tasks.openFolder(msg.id);
      case "loadSkills":
        return this.loadSkills();
      case "searchSkills":
        return this.searchSkillGallery(msg.query);
      case "inspectSkill":
        return this.inspectSkillPreview(msg.identifier);
      case "installSkill":
        return this.installSkillFromGallery(msg.identifier, msg.name, msg.source, msg.trust);
      case "uninstallSkill":
        return this.uninstallSkillFromGallery(msg.name);
      case "mentionQuery": {
        const items: MentionItem[] = await this.files.search(msg.query).catch(() => []);
        if (this.features.index.enabled && "codebase".startsWith(msg.query.toLowerCase())) {
          items.unshift({ kind: "codebase", path: "", label: "codebase" });
        }
        (reply ?? this.post)?.({ type: "mentionResults", requestId: msg.requestId, items });
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
      case "restoreCheckpoint":
        return this.restoreCheckpoint(msg.turn);
      case "undoRestore":
        return this.undoRestore();
      case "openRules":
        return this.openRules();
      case "showUsage":
        return this.showUsage();
      case "installHermes":
        return this.maintenance.install();
      case "runHermesSetup":
        return this.maintenance.runSetupWizard();
      case "checkHermesUpdate":
        return this.maintenance.checkUpdate(true);
      case "updateHermes":
        return this.maintenance.update();
      case "dismissOnboarding":
        return this.finishOnboarding();
      case "setLocalOnly":
        return this.setLocalOnly(msg.enabled);
      case "saveAllowedHosts":
        return this.saveAllowedHosts(msg.hosts);
      case "showPrivacy":
        return this.showPrivacy();
    }
  }

  /** Adds a context chip to the composer (selection command, explorer "Add to chat"). */
  addContext(ref: ContextRef): void {
    this.activeView?.({ type: "addContext", ref });
  }

  /** A view that just came up gets the full picture; the others already have it. */
  private sendInit(to?: (msg: HostToView) => void): void {
    (to ?? this.post)?.({ type: "init", locale: this.locale, state: this.state, items: this.transcript.all() });
  }

  private setState(patch: Partial<ViewState>): void {
    // Queued messages belong to the session they were typed in.
    if ("sessionId" in patch && patch.sessionId !== this.state.sessionId && this.queue.length) {
      this.queue.length = 0;
      this.pendingSteers.length = 0;
      this.sendQueueAfterStop = false;
      patch = { ...patch, queued: [] };
    }
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
        hermesStatus: versionStatus(version),
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
    this.updatePrivacy();
    this.setState({ stacks: this.stackTemplates.views() });
    this.setState({ phase: this.client?.isAlive ? "ready" : "stopped" });
    if (autoStart && this.post && !this.client && !this.state.privacy?.blocked) void this.ensureStarted();
  }

  ensureStarted(): Promise<boolean> {
    if (this.restarting) return this.restarting.then(() => this.ensureStarted());
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
      this.updatePrivacy();
      if (this.state.privacy?.blocked) {
        this.log.info(`full local mode keeps Hermes from starting: ${this.state.privacy.blocked}`);
        this.setState({ phase: "stopped", phaseDetail: undefined });
        return false;
      }
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
      this.publishUsage();
      this.markRestorable();
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
  restart(): Promise<void> {
    return this.trackRestart(async () => {
      const sessionId = this.state.sessionId;
      await this.shutdown();
      await this.refresh(false);
      if (this.state.phase !== "stopped") return;
      this.starting = this.start(sessionId).finally(() => (this.starting = undefined));
      if ((await this.starting) && sessionId && this.state.sessionId === sessionId) {
        this.notice("info", this.tr("notice.restarted"));
      }
    });
  }

  /** Endpoint changed: the old session belongs to another Hermes home or provider, so start clean. */
  private restartFresh(): Promise<void> {
    return this.trackRestart(async () => {
      await this.shutdown();
      this.resetTranscript();
      this.setState({ sessionId: undefined, models: [], currentModelId: undefined, usage: undefined, sessionUsage: undefined, canUndoRestore: false, sessionTitle: undefined });
      await this.refresh();
    });
  }

  private trackRestart(run: () => Promise<void>): Promise<void> {
    const done: Promise<void> = run().finally(() => {
      if (this.restarting === done) this.restarting = undefined;
    });
    this.restarting = done;
    return done;
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

  /**
   * A text message sent while a turn runs is slipped into it with Hermes' /steer: the agent reads it after
   * the current tool batch, without stopping. Messages with attachments (steer is text-only) wait in the
   * queue instead and go out, merged, once the turn completes.
   */
  async send(text: string, context: ContextRef[] = [], steerId?: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (this.state.busy || this.turnStarting) {
      if (this.state.busy && !context.length && !steerId) return this.steer(trimmed);
      this.queue.push({ id: `q${++this.seq}`, text: trimmed, context });
      this.publishQueue();
      return;
    }
    this.turnStarting = true;
    let completed = false;
    try {
      completed = await this.runTurn(trimmed, context, steerId);
    } finally {
      this.turnStarting = false;
    }
    // A steer that arrived after the agent's last tool batch has nothing to land in; Hermes drops it
    // over ACP, so send it now as the next prompt (or keep it queued when the turn was stopped).
    const undelivered = this.pendingSteers.splice(0);
    if (undelivered.length) {
      if (completed) {
        void this.send(undelivered.map((s) => s.text).join("\n\n"), [], undelivered[0].id);
        return;
      }
      this.queue.unshift(...undelivered.map((s) => ({ id: `q${++this.seq}`, text: s.text, context: [], steerId: s.id })));
      this.publishQueue();
    }
    // A stopped or failed turn leaves the queue for the user, unless "send now" stopped it.
    if (completed || this.sendQueueAfterStop) void this.sendQueued();
  }

  /** Slips a message into the running turn; falls back to the queue if Hermes will not take it. */
  private async steer(text: string): Promise<void> {
    const client = this.client;
    const sessionId = this.state.sessionId;
    if (!client || !sessionId) return;
    const id = this.transcript.addSteer(text);
    this.scheduleFlush();
    const entry = { id, text };
    this.pendingSteers.push(entry);
    this.steerAcks++;
    try {
      await client.prompt(sessionId, [{ type: "text", text: `/steer ${text}\n\n${STEER_NOTE}` }]);
    } catch (error) {
      this.log.info(`steer failed: ${(error as Error).message}`);
      const i = this.pendingSteers.indexOf(entry);
      if (i >= 0) this.pendingSteers.splice(i, 1);
      this.queue.push({ id: `q${++this.seq}`, text, context: [] });
      this.publishQueue();
    }
  }

  /** Sends everything queued as one message: right away when idle, after stopping the running turn otherwise. */
  async sendQueued(): Promise<void> {
    if (!this.queue.length) return;
    if (this.state.busy || this.turnStarting) {
      this.sendQueueAfterStop = true;
      return this.stop();
    }
    this.sendQueueAfterStop = false;
    const items = this.queue.splice(0);
    this.publishQueue();
    // A steer already on screen keeps its bubble instead of getting a second one.
    await this.send(items.map((q) => q.text).join("\n\n"), items.flatMap((q) => q.context), items[0].steerId);
  }

  private publishQueue(): void {
    this.setState({ queued: this.queue.map((q) => ({ id: q.id, text: q.text, attachments: q.context.length })) });
  }

  /** Runs one turn; true when it finished on its own (not stopped, not failed, not refused before it started). */
  private async runTurn(trimmed: string, context: ContextRef[], steerId?: string): Promise<boolean> {
    this.updatePrivacy();
    if (this.state.privacy?.blocked) {
      this.notice("error", this.tr("privacy.blocked", this.state.privacy.blocked));
      return false;
    }
    if (!(await this.ensureStarted()) || !this.client || !this.state.sessionId) return false;

    const cwd = this.cwd;
    const sessionId = this.state.sessionId;
    this.reportedErrors.clear();
    this.turnProviderStatuses.length = 0;
    this.turnGaveUp = false;

    // Project rules: sent with the first prompt of a session and again whenever they change.
    const rules = this.rules.load();
    const ruleNotes: string[] = [];
    const ruleChips: { label: string; path: string; kind: "rules" }[] = [];
    if (rules && this.rulesSent.get(sessionId) !== rules.hash) {
      ruleNotes.push(rulesNote(rules));
      this.rulesSent.set(sessionId, rules.hash);
      for (const f of rules.files) ruleChips.push({ label: f.path, path: cwd ? path.join(cwd, ...f.path.split("/")) : f.path, kind: "rules" });
    } else if (!rules && this.rulesSent.has(sessionId)) {
      ruleNotes.push(RULES_REMOVED_NOTE);
      this.rulesSent.delete(sessionId);
    }

    // A steer Hermes never delivered keeps its bubble and becomes this turn's message.
    const user = (steerId && this.transcript.promoteSteer(steerId, trimmed)) || this.transcript.addUser(trimmed, [...ruleChips, ...context.map((c) => ({
      label: contextLabel(c, cwd), path: c.path, kind: c.kind,
      ...(c.kind === "image" && c.data ? { image: `data:${c.mimeType ?? "image/png"};base64,${c.data}` } : {}),
    }))]);
    this.currentTurn = user.turn;
    this.turnStartedAt = Date.now();
    this.checkpoints.begin(sessionId, user.turn, trimmed);
    if (this.state.onboarding) this.finishOnboarding();
    this.scheduleFlush();
    const notes = this.notesForNextPrompt.splice(0);
    if (this.state.mode === "plan") notes.unshift(PLAN_NOTE);
    if (this.state.mode === "ask") notes.unshift(ASK_NOTE);
    const agentLanguage = effectiveAgentLanguage(parseAgentLanguage(vscode.workspace.getConfiguration("hermes").get("agentLanguage")), this.locale);
    if (this.state.learning?.on) notes.unshift(learningNote(agentLanguage ?? this.locale, this.state.learning.level));
    const languageChange = this.languageNoteFor(sessionId, agentLanguage);
    if (languageChange) ruleNotes.unshift(languageChange);
    // Hermes' system prompt also advertises its scratch dir for temporary files, and some models
    // then save deliverables there. Name the workspace once per session so results land in it.
    if (cwd && !this.briefedSessions.has(this.state.sessionId)) {
      this.briefedSessions.add(this.state.sessionId);
      notes.unshift(workspaceNote(cwd));
    }
    // Narrate steps: some models (Gemini Flash) call tools without a word in between.
    if (vscode.workspace.getConfiguration("hermes").get<boolean>("narrateSteps", true) && !this.narratedSessions.has(sessionId)) {
      this.narratedSessions.add(sessionId);
      ruleNotes.push(NARRATE_NOTE);
    }
    // Rules go right after the workspace note, before mode notes and anything queued.
    notes.splice(notes[0]?.startsWith("[IDE] The user's project") ? 1 : 0, 0, ...ruleNotes);
    const body = notes.length ? `${notes.join("\n")}\n\n${trimmed}` : trimmed;
    if (context.some((c) => c.kind === "folder")) await this.files.ensure();
    const expanded = await this.expandCodebase(trimmed, context);
    const blocks = buildPromptBlocks(body, expanded, { cwd, folderListing: (f) => this.files.listFolder(f), readFile: readContextFile });
    this.setState({ busy: true, turnUsage: undefined });
    this.sessionsChanged.fire();
    const client = this.client;
    await this.applyRouting(sessionId, trimmed, context); // a model switch can take seconds, so only once the turn shows as running
    let outcome = await this.runPrompt(client, sessionId, blocks);
    // The chosen model may have failed before it answered (rate limit, out of credits, endpoint down): try the fallback once.
    if (!outcome.stopped && this.failedBeforeAnswer(user.id, outcome.error) && (await this.failOver(client, sessionId))) {
      outcome = await this.runPrompt(client, sessionId, blocks);
    }
    try {
      if (outcome.error && client.isAlive) this.notice("error", this.tr("notice.promptFailed", outcome.error.message));
      this.transcript.endTurn();
      this.checkpoints.finish(sessionId, user.turn);
      this.markRestorable();
      this.publishUsage();
      this.scheduleFlush();
    } finally {
      this.setState({ busy: false });
      this.sessionsChanged.fire();
      if (!outcome.stopped) this.notifier.notify("done", this.state.sessionTitle ?? trimmed.split("\n")[0].slice(0, 80), Date.now() - this.turnStartedAt);
    }
    return !outcome.stopped && !outcome.error;
  }

  /** Sends one prompt and records what it cost. Never throws: a failure comes back in `error`. */
  private async runPrompt(client: AcpClient, sessionId: string, blocks: acp.ContentBlock[]): Promise<{ stopped: boolean; error?: Error }> {
    try {
      const res = await client.prompt(sessionId, blocks);
      const usage = fromAcpUsage(res.usage);
      if (usage) {
        this.usageTracker.record({ at: Date.now(), sessionId, profileId: this.profiles.activeId(), model: this.state.currentModelId ?? "unknown", usage });
      }
      const stopped = res.stopReason === "cancelled";
      if (stopped) this.notice("info", this.tr("notice.stopped"));
      else if (res.stopReason === "refusal") this.notice("warn", "refusal");
      return { stopped };
    } catch (error) {
      return { stopped: false, error: error as Error };
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
      this.currentTurn = -1;
      this.setState({ sessionId: created.sessionId, sessionTitle: undefined, usage: undefined, sessionUsage: undefined, canUndoRestore: false });
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
    if (modelBlockedByLocalMode(modelId)) {
      this.notice("warn", this.tr("privacy.modelBlocked", shortModelName(modelId, this.availableModels)));
      return;
    }
    try {
      await this.client.setModel(this.state.sessionId, modelId);
      this.setState({ currentModelId: modelId });
      if (!this.profiles.active()) await this.context.globalState.update(PREFERRED_MODEL_KEY, modelId);
    } catch (error) {
      this.notice("error", this.tr("notice.modelFailed", (error as Error).message));
    }
  }

  private applyModels(models: HermesModelState | null | undefined): void {
    this.hermesModels = models?.availableModels ?? [];
    if (!this.profiles.active()) this.endpointModels = [];
    this.publishModels(models?.currentModelId);
    void this.discoverEndpointModels();
  }

  /**
   * A custom endpoint (Ollama, vLLM, ...) usually serves several models while Hermes lists only the one the profile
   * names. Hermes accepts the others as "custom:<id>" when switching, so they are offered here too.
   */
  private async discoverEndpointModels(): Promise<void> {
    const profile = this.profiles.active();
    if (!profile || blockedByLocalMode(profile.baseUrl)) return;
    const ids = await listEndpointModels({ baseUrl: profile.baseUrl, apiKey: await this.profiles.key(profile.id) });
    if (this.profiles.active()?.baseUrl !== profile.baseUrl) return; // the user switched meanwhile
    const next = ids.map((id) => ({ modelId: `custom:${id}`, name: id }));
    if (JSON.stringify(next) === JSON.stringify(this.endpointModels)) return;
    this.endpointModels = next;
    this.publishModels(this.state.currentModelId);
  }

  private publishModels(current: string | undefined): void {
    const listed = new Set(this.hermesModels.map((m) => m.modelId));
    this.availableModels = [...this.hermesModels, ...this.endpointModels.filter((m) => !listed.has(m.modelId))];
    const shortCounts = new Map<string, number>();
    for (const m of this.availableModels) {
      const s = shortModelName(m.modelId, this.availableModels);
      shortCounts.set(s, (shortCounts.get(s) ?? 0) + 1);
    }
    const options: ModelOption[] = this.availableModels.map((m) => {
      const s = shortModelName(m.modelId, this.availableModels);
      return {
        id: m.modelId, label: (shortCounts.get(s) ?? 0) > 1 ? m.name : s, group: modelGroup(m.modelId, m.name),
        ...(modelBlockedByLocalMode(m.modelId) ? { blocked: true } : {}),
      };
    });
    if (current && !options.some((o) => o.id === current)) {
      options.unshift({ id: current, label: shortModelName(current, this.availableModels), group: modelGroup(current, "") });
    }
    this.setState({ models: options, currentModelId: current });
    this.updatePrivacy(); // the model in use may itself be one that local mode does not allow
  }

  /** Profile "hermes": re-applies the model the user last picked (e.g. customer-service). */
  private async applyPreferredModel(): Promise<void> {
    if (this.profiles.active()) return;
    const preferred = this.context.globalState.get<string>(PREFERRED_MODEL_KEY);
    if (!preferred || preferred === this.state.currentModelId) return;
    if (!this.availableModels.some((m) => m.modelId === preferred)) return;
    if (modelBlockedByLocalMode(preferred)) return;
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
    const u = n.update;
    if (this.steerAcks > 0 && u.sessionUpdate === "agent_message_chunk" && u.content.type === "text" && /^(⏩ Steer queued|⚠️ Steer failed)/.test(u.content.text)) {
      this.steerAcks--;
      if (u.content.text.startsWith("⚠️")) this.notice("warn", u.content.text);
      return;
    }
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
    if (/Non-retryable client error|API call failed after \d+ retries/.test(line)) this.turnGaveUp = true;
    // Logged when a steer lands after a tool batch; steers sent before it were drained together.
    if (line.includes("Delivered /steer")) this.pendingSteers.length = 0;
    const call = parseApiCallLine(line);
    // Inline edits run in their own hidden session; their requests are not this turn's.
    if (call && this.state.busy && !(call.session && this.inlineReplies.has(call.session))) {
      this.setState({ turnUsage: addCall(this.state.turnUsage, call) });
      return;
    }
    if (!line.includes("Error code:")) return;
    const err = parseProviderError(line);
    if (!err) return;
    this.turnProviderStatuses.push(err.status);
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

  private async postSessions(requestId: number, reply?: (msg: HostToView) => void): Promise<void> {
    const list = await this.listSessions().catch((error) => {
      this.log.info(`listing sessions failed: ${(error as Error).message}`);
      return [];
    });
    const sessions: SessionView[] = list.map((s) => ({
      id: s.id, title: s.title, updatedAt: parseSessionTime(s.updatedAt), current: s.id === this.state.sessionId,
    }));
    (reply ?? this.post)?.({ type: "sessions", requestId, sessions });
  }

  /** Resumes a session from history: Hermes replays it into a fresh transcript. */
  async openSession(sessionId: string, title?: string): Promise<void> {
    if (sessionId === this.state.sessionId) return;
    if (this.state.busy) await this.stop();
    if (!(await this.ensureStarted()) || !this.client || !this.cwd) return;
    this.cancelPending();
    this.notesForNextPrompt.length = 0;
    this.resetTranscript();
    const previous = this.state.sessionId;
    // Set before loading so the replayed updates pass the session filter.
    this.currentTurn = -1;
    this.setState({ sessionId, sessionTitle: undefined, usage: undefined, sessionUsage: undefined });
    try {
      const loaded = await this.client.loadSession(this.cwd, sessionId, await this.mcpServersForSession());
      if (!loaded) throw new Error("session not found");
      await this.pinAskMode(this.client, sessionId);
      this.applyModels(loaded.models);
      this.transcript.endTurn();
      this.scheduleFlush();
      // The replay may carry its own title; otherwise keep the one the list showed.
      if (title && !this.state.sessionTitle) this.setState({ sessionTitle: title });
      this.currentTurn = this.transcript.userCount - 1; // keeps checkpoints of a resumed session numbered consistently
      this.publishUsage();
      this.markRestorable();
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
        // A command the agent may now run can change files in ways a checkpoint cannot undo.
        if (parsed.variant === "execute" && req.sessionId === this.state.sessionId && this.currentTurn >= 0 && allows(response, req.options)) {
          this.checkpoints.noteCommand(req.sessionId, this.currentTurn);
        }
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
        // Full local mode: a command that may reach the network asks every time, like a risky one, and cannot be always-allowed.
        const privacy = privacySettings();
        const netReason = privacy.localOnly ? networkCommandReason(parsed.command, privacy.allowedHosts) : undefined;
        // A command to a server (ssh, scp, sftp, rsync, git push to a deploy remote) always asks, in every mode, and cannot be always-allowed.
        const deployInfo = this.deploy.analyze(parsed.command);
        const risky = !!danger || !!netReason || !!deployInfo;
        const title = parsed.tool === "execute_code" ? this.tr("perm.executeCode") : this.tr("perm.execute");
        const base = { kind: "permission" as const, id: itemId, variant: "execute" as const, title, command: parsed.command };
        // Ask mode is read-only: no commands, not even allowlisted ones.
        if (this.state.mode === "ask") {
          this.transcript.upsert({ ...base, actions: [], state: "rejected", resolution: this.tr("perm.askRejected") });
          this.scheduleFlush();
          respond(selected(pickOption(req.options, "reject")));
          return;
        }
        if (!risky && parsed.tool !== "execute_code" && this.allowlist().allows(parsed.command)) {
          this.transcript.upsert({ ...base, actions: [], state: "allowed", resolution: this.tr("perm.autoAllowed") });
          this.scheduleFlush();
          if (parsed.viaHook) this.hookApprovals.set(key, Date.now() + HOOK_APPROVAL_TTL_MS);
          respond(selected(pickOption(req.options, "allow_once")));
          return;
        }
        // Auto mode: commands that pass the safety check run; risky ones still ask.
        if (this.state.mode === "auto" && !risky && parsed.tool !== "execute_code") {
          this.transcript.upsert({ ...base, actions: [], state: "allowed", resolution: this.tr("perm.autoMode") });
          this.scheduleFlush();
          if (parsed.viaHook) this.hookApprovals.set(key, Date.now() + HOOK_APPROVAL_TTL_MS);
          respond(selected(pickOption(req.options, "allow_once")));
          return;
        }
        // Super Auto: dangerous commands and execute_code run too; only server deploys and network in local mode still ask.
        if (this.state.mode === "superAuto" && !netReason && !deployInfo) {
          this.transcript.upsert({
            ...base, actions: [], state: "allowed", resolution: this.tr("perm.superAutoMode"),
            dangerReason: danger ? this.tr("perm.dangerous", danger) : undefined,
          });
          this.scheduleFlush();
          if (parsed.viaHook) this.hookApprovals.set(key, Date.now() + HOOK_APPROVAL_TTL_MS);
          respond(selected(pickOption(req.options, "allow_once")));
          return;
        }
        const actions: PermissionAction[] = risky || parsed.tool === "execute_code"
          ? ["allow_once", "reject"]
          : ["allow_once", "allow_always_ws", "reject"];
        this.transcript.upsert({
          ...base, actions, state: "pending", why: this.agentReason(),
          dangerReason: [
            danger ? this.tr("perm.dangerous", danger) : "",
            netReason ? this.tr("privacy.networkCommand", netReason) : "",
            deployInfo ? this.deploy.describe(deployInfo) : "",
          ].filter(Boolean).join(" ") || undefined,
        });
      } else if (parsed.variant === "edit") {
        if (this.decideEditByMode(entry, parsed)) return;
        this.startEditReview(entry, parsed);
      } else if (this.state.mode === "superAuto") {
        this.transcript.upsert({
          kind: "permission", id: itemId, variant: "other", title: req.toolCall.title ?? this.tr("perm.other"),
          actions: [], state: "allowed", resolution: this.tr("perm.superAutoMode"),
        });
        this.scheduleFlush();
        respond(selected(pickOption(req.options, "allow_once")));
        return;
      } else {
        this.transcript.upsert({
          kind: "permission", id: itemId, variant: "other", title: req.toolCall.title ?? this.tr("perm.other"),
          actions: ["allow_once", "reject"], state: "pending",
        });
      }
      this.pending.set(itemId, entry);
      this.scheduleFlush();
      this.notifier.notify("permission", permissionSummary(parsed, req));
    });
  }

  /** Saves the files an approved edit is about to change, before Hermes is told it may write. */
  private snapshotForEdit(entry: PendingPermission, parsed: Extract<ParsedPermission, { variant: "edit" }>): void {
    // Inline edits run in their own hidden session; Ctrl+Z and the diff review cover those.
    if (entry.sessionId !== this.state.sessionId || this.currentTurn < 0) return;
    const cwd = this.cwd ?? "";
    const paths = (parsed.isPatch ? parsed.paths : [parsed.path]).map((p) => (path.isAbsolute(p) ? p : path.join(cwd, p)));
    if (!this.checkpoints.recordBefore(entry.sessionId, this.currentTurn, paths) && !this.checkpointWarned) {
      this.checkpointWarned = true;
      this.notice("warn", this.tr("checkpoint.snapshotFailed"));
    }
  }

  /** Plan rejects edits; "Edit automatically" and Auto apply safe ones without the diff review, Super Auto applies all. */
  private decideEditByMode(entry: PendingPermission, parsed: Extract<ParsedPermission, { variant: "edit" }>): boolean {
    const mode = this.state.mode;
    if (mode === "manual") return false;
    const cwd = this.cwd ?? "";
    const absPath = path.isAbsolute(parsed.path) ? parsed.path : path.join(cwd, parsed.path);
    const outside = parsed.paths.some((p) => !isInside(cwd, path.isAbsolute(p) ? p : path.join(cwd, p)));
    const dirty = vscode.workspace.textDocuments.some((d) => d.isDirty && samePath(d.uri.fsPath, absPath));
    const title = parsed.isPatch && parsed.paths.length > 1 ? this.tr("perm.editPatch", parsed.paths.length) : this.tr("perm.edit");
    const card = { kind: "permission" as const, id: entry.itemId, variant: "edit" as const, title, path: absPath, paths: parsed.paths, actions: [] };
    if (mode === "plan" || mode === "ask") {
      this.transcript.upsert({ ...card, state: "rejected", resolution: this.tr(mode === "ask" ? "perm.askRejected" : "perm.planRejected") });
      this.scheduleFlush();
      entry.respond(selected(pickOption(entry.options, "reject")));
      return true;
    }
    if ((outside || dirty) && mode !== "superAuto") return false;
    const stat = parsed.isPatch ? undefined : diffStat(parsed.oldText ?? "", parsed.newText);
    this.transcript.upsert({
      ...card, added: stat?.added, removed: stat?.removed, state: "allowed",
      resolution: this.tr(mode === "superAuto" ? "perm.superAutoMode" : "perm.autoEdit"),
      dangerReason: [outside ? this.tr("perm.outside") : "", dirty ? this.tr("perm.dirty") : ""].filter(Boolean).join(" ") || undefined,
    });
    this.scheduleFlush();
    this.snapshotForEdit(entry, parsed);
    entry.respond(selected(pickOption(entry.options, "allow_once")));
    return true;
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
      dangerReason: warnings.join(" ") || undefined, why: this.agentReason(), actions: ["review", "allow_once", "reject"], state: "pending",
    });

    void this.reviews
      .start({ id: entry.reviewId, path: absPath, oldText: parsed.oldText ?? "", newText: parsed.newText, isPatch: parsed.isPatch })
      .then((decision) => {
        if (decision.cancelled) return this.resolveCard(entry, cancelled(), "cancelled", this.tr("perm.cancelled"));
        if (!decision.accept) {
          return this.resolveCard(entry, selected(pickOption(entry.options, "reject")), "rejected", this.tr("perm.rejected"));
        }
        const partial = !parsed.isPatch && decision.acceptedHunks.length < decision.totalHunks;
        this.snapshotForEdit(entry, parsed);
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
    if (entry.parsed.variant === "execute") {
      const analysis = this.deploy.analyze(entry.parsed.command);
      if (analysis) void this.deploy.record(entry.parsed.command, analysis, state);
    }
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

  // ---- phase 5: checkpoints, usage, rules, onboarding ---------------------------------------

  /** Flags user messages whose turn (or a later one) changed files, so the panel can offer "Restore to here". */
  private markRestorable(): void {
    const sessionId = this.state.sessionId;
    if (!sessionId) return;
    const changed = this.checkpoints.restorableTurns(sessionId);
    const lastChanged = Math.max(-1, ...changed);
    const commands = this.checkpoints.commandTurns(sessionId);
    for (const item of this.transcript.all()) {
      if (item.kind !== "user" || item.turn === undefined) continue;
      const restorable = item.turn <= lastChanged;
      const ranCommands = [...commands].some((c) => c >= item.turn!);
      if (item.restorable !== restorable || item.ranCommands !== ranCommands) this.transcript.patch(item.id, "user", { restorable, ranCommands });
    }
    this.scheduleFlush();
    this.setState({ canUndoRestore: this.checkpoints.canUndo(sessionId) });
  }

  /** Confirms with the exact list of changes, then puts the files back. Never touches the conversation itself. */
  async restoreCheckpoint(turn: number): Promise<void> {
    const sessionId = this.state.sessionId;
    if (!sessionId) return;
    if (this.state.busy) return void vscode.window.showWarningMessage(this.tr("checkpoint.busy"));
    const plan = this.checkpoints.plan(sessionId, turn);
    if (!plan || (!plan.items.length && !plan.skipped.length)) return void vscode.window.showInformationMessage(this.tr("checkpoint.nothing"));

    const dirty = new Set(vscode.workspace.textDocuments.filter((d) => d.isDirty).map((d) => path.resolve(d.uri.fsPath).toLowerCase()));
    const lines = plan.items.slice(0, 12).map((it) => {
      const flags = [
        it.modifiedSince ? this.tr("checkpoint.itemModified") : "",
        dirty.has(path.resolve(it.abs).toLowerCase()) ? this.tr("checkpoint.itemDirty") : "",
      ].filter(Boolean);
      const base = "• " + this.tr(it.action === "delete" ? "checkpoint.itemDelete" : "checkpoint.itemWrite", it.path);
      return flags.length ? `${base} — ${flags.join("; ")}` : base;
    });
    if (plan.items.length > 12) lines.push(this.tr("checkpoint.more", plan.items.length - 12));
    const detail = [
      lines.join("\n"),
      plan.ranCommand ? this.tr("checkpoint.ranCommand") : "",
      plan.skipped.length ? this.tr("checkpoint.skipped", plan.skipped.map((s) => s.path).join(", ")) : "",
      this.tr("checkpoint.undoable"),
    ].filter(Boolean).join("\n\n");
    const confirm = this.tr("checkpoint.confirmButton");
    const answer = await vscode.window.showWarningMessage(this.tr("checkpoint.confirmTitle", plan.items.length), { modal: true, detail }, confirm);
    if (answer !== confirm) return;

    try {
      const result = this.checkpoints.restore(sessionId, turn);
      this.log.info(`checkpoint restore to turn ${turn}: ${result.written} written, ${result.deleted} deleted`);
      this.notesForNextPrompt.push(this.tr("note.restored", turn + 1, plan.items.map((i) => i.path).join(", ")));
      this.markRestorable();
      const undo = this.tr("checkpoint.undo");
      this.notice("info", this.tr("checkpoint.done", result.written, result.deleted));
      void vscode.window.showInformationMessage(this.tr("checkpoint.done", result.written, result.deleted), undo).then((choice) => {
        if (choice === undo) void this.undoRestore();
      });
    } catch (error) {
      this.notice("error", this.tr("checkpoint.failed", (error as Error).message));
    }
  }

  async undoRestore(): Promise<void> {
    const sessionId = this.state.sessionId;
    if (!sessionId) return;
    try {
      const result = this.checkpoints.undoRestore(sessionId);
      if (!result) return void vscode.window.showInformationMessage(this.tr("checkpoint.noUndo"));
      this.markRestorable();
      this.notice("info", this.tr("checkpoint.undone"));
    } catch (error) {
      this.notice("error", this.tr("checkpoint.failed", (error as Error).message));
    }
  }

  private publishUsage(): void {
    this.setState({ sessionUsage: this.usageTracker.view(this.state.sessionId) });
  }

  /** Opens the usage report (this session, today, 7 and 30 days) as a Markdown document. */
  async showUsage(): Promise<void> {
    const content = this.usageTracker.report(this.locale, this.state.sessionId, this.state.sessionTitle);
    const doc = await vscode.workspace.openTextDocument({ language: "markdown", content });
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  async openRules(): Promise<void> {
    const { created } = await this.rules.openOrCreate(this.locale);
    if (created) this.notice("info", this.tr("rules.created", created));
    this.setState({ rules: this.rules.view() });
  }

  private finishOnboarding(): void {
    void this.context.globalState.update(ONBOARDED_KEY, true);
    this.setState({ onboarding: false });
  }

  // ---- phase 6: full local mode -------------------------------------------------------------

  private privacyReport(): PrivacyReport {
    const settings = privacySettings();
    const profile = this.profiles.active();
    const hc = this.state.endpoint.hermesConfig;
    const completion = this.features.completion.view();
    const index = this.features.index.view();
    // An IDE-owned profile gets the hook whenever a Node runtime exists; the user's own config only once it is installed.
    const guardActive = this.state.terminalApproval === "active" || (!!profile && this.approval.canInstall());
    return evaluatePrivacy({
      localOnly: settings.localOnly,
      allowedHosts: settings.allowedHosts,
      model: profile ? { kind: "custom", baseUrl: profile.baseUrl } : { kind: "hermes", baseUrl: hc?.baseUrl, provider: hc?.provider },
      completion: { enabled: completion.enabled, baseUrl: completion.baseUrl },
      index: { enabled: index.enabled, baseUrl: index.baseUrl },
      mcpServers: this.mcpSettings().map((s) => ({ name: s.name, type: s.type, url: s.url, enabled: s.enabled !== false })),
      guardActive,
      currentModelId: this.state.currentModelId,
      configEndpoints: profile ? [] : this.hermesConfigEndpoints,
    });
  }

  /** Re-judges the configuration and publishes whether the agent may run (and why not). */
  private updatePrivacy(): void {
    const settings = privacySettings();
    const report = this.privacyReport();
    const blocked = settings.localOnly && report.blockers.length
      ? report.blockers.map((b) => this.tr(b.reason, ...(b.args ?? []))).join(" ")
      : undefined;
    const needsGuard = !!blocked && report.blockers.every((b) => b.id === "tools") && !this.profiles.active();
    this.setState({
      privacy: { localOnly: settings.localOnly, allowedHosts: settings.allowedHosts, blocked, needsGuard },
      asksEveryCommand: this.approval.asksEveryCommand,
    });
  }

  /** The mode or the allowed hosts changed: the hook's flags travel in Hermes' environment, so a running Hermes restarts. */
  private async onPrivacyChanged(): Promise<void> {
    const now = privacySettings().localOnly;
    if (now !== this.lastLocalOnly) this.notice("info", this.tr(now ? "privacy.on" : "privacy.off"));
    this.lastLocalOnly = now;
    this.updatePrivacy();
    if (this.client) await this.restart();
  }

  async setLocalOnly(enabled: boolean): Promise<void> {
    await vscode.workspace.getConfiguration("hermes.privacy").update("localOnly", enabled, vscode.ConfigurationTarget.Global);
  }

  async saveAllowedHosts(hosts: string[]): Promise<void> {
    const clean = [...new Set(hosts.map((h) => h.trim()).filter(Boolean))];
    await vscode.workspace.getConfiguration("hermes.privacy").update("allowedHosts", clean, vscode.ConfigurationTarget.Global);
  }

  /** The privacy check as a Markdown document: every place data could go, and what the IDE does about it. */
  async showPrivacy(): Promise<void> {
    const doc = await vscode.workspace.openTextDocument({ language: "markdown", content: privacyReportMarkdown(this.privacyReport(), this.locale) });
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  // ---- phase 7: deploy ----------------------------------------------------------------------

  async showDeployHistory(): Promise<void> {
    await this.deploy.showHistory();
  }

  /** Test access to the deploy list. */
  get deployManager(): DeployManager {
    return this.deploy;
  }

  // ---- phase 7: project templates -----------------------------------------------------------

  async addStackRules(id: string): Promise<void> {
    const info = isStackId(id) ? stackInfo(id) : undefined;
    if (!info) return;
    if (!this.cwd) return this.notice("warn", this.tr("stacks.noWorkspace"));
    const result = await this.stackTemplates.add(info.id, this.locale);
    if (result) this.notice("info", this.tr(result.created ? "stacks.noticeAdded" : "stacks.noticeExists", info.label, result.path));
    this.setState({ stacks: this.stackTemplates.views(), rules: this.rules.view() });
  }

  /** "Hermes: Add Framework Rules": a pick list with the stacks detected in this project first. */
  async pickStackRules(): Promise<void> {
    const views = this.stackTemplates.views().slice().sort((a, b) => Number(b.detected) - Number(a.detected));
    const pick = await vscode.window.showQuickPick(
      views.map((v) => ({ label: v.label, description: [v.detected ? this.tr("stacks.pickDetected") : "", v.added ? this.tr("stacks.added") : ""].filter(Boolean).join(" · "), id: v.id })),
      { placeHolder: this.tr("stacks.pick") },
    );
    if (pick) await this.addStackRules(pick.id);
  }

  // ---- phase 7: endpoint presets ---------------------------------------------------------------

  /** The model list of an endpoint typed into the Custom API form, so the user picks a name instead of guessing it. */
  private async listModelsForForm(baseUrl: string, apiKey: string | undefined, profileId: string | undefined): Promise<void> {
    const base = baseUrl.trim();
    const reply = (models: string[], error?: string) => this.post?.({ type: "endpointModels", baseUrl, models, ...(error ? { error } : {}) });
    let valid = false;
    try {
      valid = /^https?:$/.test(new URL(base).protocol);
    } catch {
      valid = false;
    }
    if (!valid) return reply([], this.tr("presets.modelsNone"));
    if (blockedByLocalMode(base)) return reply([], this.tr("presets.modelsBlocked"));
    const key = apiKey || (profileId ? await this.profiles.key(profileId) : undefined);
    const models = await listEndpointModels({ baseUrl: base, apiKey: key });
    reply(models, models.length ? undefined : this.tr("presets.modelsNone"));
  }

  // ---- phase 7: language and learning mode --------------------------------------------------

  private languageView(): LanguageView {
    const cfg = vscode.workspace.getConfiguration("hermes");
    const ui = cfg.get<string>("language");
    return { ui: ui === "auto" || ui === "en" ? ui : "id", agent: parseAgentLanguage(cfg.get("agentLanguage")) };
  }

  /** The instruction to send now, or undefined when the agent was already told (English is its default, so it needs no first note). */
  private languageNoteFor(sessionId: string, wanted: "id" | "en" | undefined): string | undefined {
    if (!wanted) return undefined;
    const sent = this.languageSent.get(sessionId) ?? "en";
    if (sent === wanted) return undefined;
    this.languageSent.set(sessionId, wanted);
    return languageNote(wanted);
  }

  async setLanguage(ui?: LanguageView["ui"], agent?: LanguageView["agent"]): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("hermes");
    if (ui) await cfg.update("language", ui, vscode.ConfigurationTarget.Global);
    if (agent) await cfg.update("agentLanguage", agent, vscode.ConfigurationTarget.Global);
  }

  private learningView(): LearningView {
    return {
      on: this.context.workspaceState.get<boolean>(LEARNING_KEY) === true,
      level: parseLearningLevel(vscode.workspace.getConfiguration("hermes.learning").get("level")),
    };
  }

  async setLearning(on?: boolean, level?: LearningView["level"]): Promise<void> {
    if (level) await vscode.workspace.getConfiguration("hermes.learning").update("level", level, vscode.ConfigurationTarget.Global);
    if (on !== undefined && on !== this.state.learning?.on) {
      await this.context.workspaceState.update(LEARNING_KEY, on);
      this.setState({ learning: this.learningView() });
      this.notice("info", this.tr(on ? "learning.noticeOn" : "learning.noticeOff"));
    } else {
      this.setState({ learning: this.learningView() });
    }
  }

  async toggleLearning(): Promise<void> {
    await this.setLearning(!this.state.learning?.on);
  }

  /** Learning mode: the agent's last words before it asked, shown on the card as its reason. */
  private agentReason(): string | undefined {
    if (!this.state.learning?.on) return undefined;
    const items = this.transcript.all();
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.kind === "agent" && item.text.trim()) {
        const text = item.text.trim();
        return text.length > 600 ? `…${text.slice(-600)}` : text;
      }
      if (item.kind === "user") return undefined;
    }
    return undefined;
  }

  // ---- phase 6: Hermes' memory --------------------------------------------------------------

  /** The Hermes home this IDE's Hermes uses: the IDE-owned one for custom endpoint profiles, Hermes' own otherwise. */
  private hermesHomeDir(): string {
    return this.profiles.active() ? path.join(this.context.globalStorageUri.fsPath, "hermes-home") : defaultHermesHome();
  }

  private async postMemory(notice?: MemoryPanel["notice"]): Promise<void> {
    const home = this.hermesHomeDir();
    const yaml = await readFile(path.join(home, "config.yaml"), "utf8").catch(() => undefined);
    this.post?.({ type: "memory", panel: { ...loadMemory(home, yaml), ...(notice ? { notice } : {}) } });
  }

  private async saveMemoryTarget(target: MemoryTarget, entries: string[], hash: string): Promise<void> {
    const home = this.hermesHomeDir();
    const yaml = await readFile(path.join(home, "config.yaml"), "utf8").catch(() => undefined);
    const result = saveMemoryFile(home, yaml, target, entries, hash);
    if (result.ok) {
      this.log.info(`memory: saved ${target} (${result.view.entries.length} entries)`);
      return this.postMemory({ level: "ok", text: this.tr("memory.saved") });
    }
    const text =
      result.reason === "changed" ? this.tr("memory.changed")
      : result.reason === "tooLong" ? this.tr("memory.tooLong", result.view.limit)
      : result.reason === "entryTooLong" ? this.tr("memory.entryTooLong", result.view.limit)
      : this.tr("memory.writeFailed", result.message ?? "?");
    return this.postMemory({ level: "error", text });
  }

  private async openMemoryFile(target: MemoryTarget): Promise<void> {
    const file = memoryPath(this.hermesHomeDir(), target);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "", { flag: "a" }); // an empty file is what Hermes starts with, so opening it never fails
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(file)), { preview: false });
  }

  // ---- phase 6: parallel agent tasks ---------------------------------------------------------

  /** Why a background task cannot start right now, in the user's language. */
  private tasksBlockedReason(): string | undefined {
    if (this.state.privacy?.blocked) return this.tr("privacy.blocked", this.state.privacy.blocked);
    if (this.state.terminalApproval !== "active") return this.tr("tasks.needApproval");
    return undefined;
  }

  /** Test access to the parallel tasks. */
  get taskManager(): TaskManager {
    return this.tasks;
  }

  // ---- phase 6: skills gallery --------------------------------------------------------------

  private skillsContext(): SkillsContext | undefined {
    return this.hermesPath ? { hermes: this.hermesPath, home: this.hermesHomeDir(), env: this.launchEnvironment } : undefined;
  }

  private postSkills(patch: Partial<SkillsPanel> = {}): void {
    this.skills = { ...this.skills, ...patch };
    const blocked = privacySettings().localOnly ? this.tr("skills.localOnly") : undefined;
    this.post?.({ type: "skills", panel: { ...this.skills, ...(blocked ? { blocked } : {}) } });
  }

  private async loadSkills(): Promise<void> {
    const ctx = this.skillsContext();
    if (!ctx) return this.postSkills({ notice: { level: "error", text: this.tr("skills.noHermes") } });
    this.postSkills({ working: "list", notice: undefined });
    const listed = await listInstalledSkills(ctx);
    this.postSkills({
      working: undefined, installed: listed.skills,
      ...(listed.ok ? {} : { notice: { level: "error" as const, text: this.tr("skills.listFail", listed.error ?? "?") } }),
    });
  }

  private async searchSkillGallery(query: string): Promise<void> {
    const ctx = this.skillsContext();
    if (!ctx || privacySettings().localOnly) return this.postSkills();
    this.postSkills({ working: "search", notice: undefined, query });
    const found = await searchSkills(ctx, query);
    this.postSkills({
      working: undefined, results: found.hits,
      ...(found.ok ? {} : { notice: { level: "error" as const, text: this.tr("skills.searchFail", found.error ?? "?") } }),
    });
  }

  private async inspectSkillPreview(identifier: string): Promise<void> {
    const ctx = this.skillsContext();
    if (!ctx || privacySettings().localOnly) return this.postSkills();
    this.postSkills({ working: "search", notice: undefined });
    const preview = await inspectSkill(ctx, identifier);
    this.postSkills({ working: undefined });
    if (!preview.ok) return this.postSkills({ notice: { level: "error", text: this.tr("skills.searchFail", preview.text.slice(0, 200)) } });
    const doc = await vscode.workspace.openTextDocument({ language: "markdown", content: `# ${identifier}\n\n\`\`\`\n${preview.text}\n\`\`\`\n` });
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  private async installSkillFromGallery(identifier: string, name: string, source: string, trust: string): Promise<void> {
    const ctx = this.skillsContext();
    if (!ctx || privacySettings().localOnly) return this.postSkills();
    // The user decides, every time: a skill gives the agent new instructions and possibly scripts to run.
    const yes = this.tr("skills.confirmYes");
    const answer = await vscode.window.showWarningMessage(
      this.tr("skills.confirmInstall", name, source || "?", trust || "?"), { modal: true, detail: this.tr("skills.confirmInstallDetail") }, yes,
    );
    if (answer !== yes) return;
    this.postSkills({ working: "install", notice: undefined });
    const done = await installSkill(ctx, identifier);
    this.log.info(`skills: install ${identifier} -> ${done.ok ? "ok" : "failed"}`);
    await this.loadSkills();
    this.postSkills({
      notice: done.ok
        ? { level: "ok", text: this.tr("skills.installedOk", name) }
        : { level: "error", text: this.tr("skills.installFail", done.output.split(/\r?\n/).slice(-3).join(" ").slice(0, 300)) },
    });
  }

  private async uninstallSkillFromGallery(name: string): Promise<void> {
    const ctx = this.skillsContext();
    if (!ctx) return;
    const row = this.skills.installed.find((s) => s.name === name);
    if (!row || row.source === "local" || row.source === "builtin") return this.postSkills({ notice: { level: "error", text: this.tr("skills.cannotRemove") } });
    const yes = this.tr("skills.confirmYes");
    if ((await vscode.window.showWarningMessage(this.tr("skills.confirmUninstall", name), { modal: true }, yes)) !== yes) return;
    this.postSkills({ working: "uninstall", notice: undefined });
    const done = await uninstallSkill(ctx, name);
    this.log.info(`skills: uninstall ${name} -> ${done.ok ? "ok" : "failed"}`);
    await this.loadSkills();
    this.postSkills({
      notice: done.ok
        ? { level: "ok", text: this.tr("skills.removed", name) }
        : { level: "error", text: this.tr("skills.removeFail", done.output.split(/\r?\n/).slice(-3).join(" ").slice(0, 300)) },
    });
  }

  // ---- phase 6: automatic model routing and fallback ----------------------------------------

  private routingSettings(): RoutingSettings {
    const cfg = vscode.workspace.getConfiguration("hermes.routing");
    return parseRoutingSettings({
      enabled: cfg.get("enabled"), lightModel: cfg.get("lightModel"), heavyModel: cfg.get("heavyModel"),
      fallbackModel: cfg.get("fallbackModel"), lightMaxChars: cfg.get("lightMaxChars"),
    });
  }

  private routingView(): RoutingView {
    const { enabled, lightModel, heavyModel, fallbackModel, lightMaxChars } = this.routingSettings();
    return { enabled, lightModel, heavyModel, fallbackModel, lightMaxChars };
  }

  async saveRouting(r: RoutingView): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("hermes.routing");
    const target = vscode.ConfigurationTarget.Global;
    await cfg.update("enabled", r.enabled, target);
    await cfg.update("lightModel", r.lightModel, target);
    await cfg.update("heavyModel", r.heavyModel, target);
    await cfg.update("fallbackModel", r.fallbackModel, target);
    await cfg.update("lightMaxChars", r.lightMaxChars, target);
  }

  private modelLabel(modelId: string | undefined): string {
    return shortModelName(modelId, this.availableModels) || "?";
  }

  /** Picks the model for this message by the routing rules and switches to it, saying why. */
  private async applyRouting(sessionId: string, text: string, context: ContextRef[]): Promise<void> {
    const settings = this.routingSettings();
    if (!settings.enabled || this.routingPaused.has(sessionId) || !this.client) return;
    const decision = classifyPrompt({ text, mode: this.state.mode, context: context.map((c) => ({ kind: c.kind, chars: contextChars(c) })) }, settings);
    const named = decision.tier === "light" ? settings.lightModel : settings.heavyModel;
    if (!named) return; // this tier has no model of its own: keep the selected one
    let wanted = modelForTier(settings, decision.tier, this.availableModels, resolveModelId);
    if (!wanted) {
      if (!this.warnedRoutingModels.has(named)) {
        this.warnedRoutingModels.add(named);
        this.notice("warn", this.tr("routing.modelMissing", named));
      }
      return;
    }
    let reason = decision.reason;
    const fallback = settings.fallbackModel ? resolveModelId(this.availableModels, settings.fallbackModel) : undefined;
    if ((this.modelCooldown.get(wanted) ?? 0) > Date.now() && fallback && fallback !== wanted) {
      wanted = fallback;
      reason = "routing.reason.cooldown";
    }
    if (wanted === this.state.currentModelId || modelBlockedByLocalMode(wanted)) return;
    try {
      await this.client.setModel(sessionId, wanted);
      this.setState({ currentModelId: wanted });
      this.notice("info", this.tr("routing.switched", this.modelLabel(wanted), this.tr(reason)));
    } catch (error) {
      this.notice("warn", this.tr("notice.modelFailed", (error as Error).message));
    }
  }

  /**
   * True when the model never really answered: the request failed, or Hermes logged that it gave up on a provider
   * error that another model may not share. Hermes then writes its own error text as the reply, so the reply cannot
   * tell us. Never after a tool ran: sending the message again would repeat what it did.
   */
  private failedBeforeAnswer(userItemId: string, error: Error | undefined): boolean {
    const items = this.transcript.all();
    const after = items.slice(items.findIndex((i) => i.id === userItemId) + 1);
    if (after.some((i) => i.kind === "tool" || i.kind === "permission")) return false;
    return !!error || (this.turnGaveUp && this.turnProviderStatuses.some(worthFallback));
  }

  /** Switches to the fallback model for a retry. Returns false when there is none to switch to. */
  private async failOver(client: AcpClient, sessionId: string): Promise<boolean> {
    const settings = this.routingSettings();
    if (!settings.enabled || !settings.fallbackModel) return false;
    const failing = this.state.currentModelId;
    const target = resolveModelId(this.availableModels, settings.fallbackModel);
    if (!target || target === failing || modelBlockedByLocalMode(target)) return false;
    const status = this.turnProviderStatuses.find(worthFallback);
    if (failing) this.modelCooldown.set(failing, Date.now() + 5 * 60_000);
    try {
      await client.setModel(sessionId, target);
    } catch (error) {
      this.notice("warn", this.tr("notice.modelFailed", (error as Error).message));
      return false;
    }
    this.setState({ currentModelId: target });
    this.notice("info", this.tr("routing.failover", this.modelLabel(failing), status ?? "?", this.modelLabel(target)));
    this.turnProviderStatuses.length = 0;
    this.turnGaveUp = false;
    return true;
  }

  // ---- endpoint profiles (F-04, F-05, F-16) -------------------------------------------------

  private async loadSettingsView(): Promise<void> {
    this.log.setSecrets(await this.allSecrets());
    const configPath = path.join(defaultHermesHome(), "config.yaml");
    const hermesYaml = await readFile(configPath, "utf8").catch(() => "");
    this.hermesConfigEndpoints = scanHermesConfig(hermesYaml);
    const hermesConfig = { ...readHermesModelConfig(hermesYaml), path: configPath };
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
    const profileHome = this.hermesHomeDir();
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

    if (blockedByLocalMode(msg.baseUrl)) {
      this.setState({ test: { running: false, ok: false, message: this.tr("privacy.model.remote", msg.baseUrl) } });
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
    const allowedMcp = privacySettings().localOnly
      ? this.mcpSettings().filter((s) => s.type === "stdio" || !blockedByLocalMode(s.url ?? ""))
      : this.mcpSettings();
    const servers = toAcpMcpServers(allowedMcp);
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
    if (blockedByLocalMode(msg.baseUrl)) {
      this.setState({ completionTest: { running: false, ok: false, message: this.tr("privacy.feature.remote", msg.baseUrl) } });
      return;
    }
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
    if (blockedByLocalMode(msg.baseUrl)) {
      this.setState({ indexTest: { running: false, ok: false, message: this.tr("privacy.feature.remote", msg.baseUrl) } });
      return;
    }
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

/** Size of the code a mention brings in, for routing; a file is measured on disk, never read. */
function contextChars(c: ContextRef): number {
  if (c.kind === "selection") return c.text?.length ?? 0;
  if (c.kind !== "file") return 0;
  try {
    return statSync(c.path).size;
  } catch {
    return 0;
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

/** True when the response lets the agent proceed (any "allow" option was chosen). */
function allows(response: acp.RequestPermissionResponse, options: acp.PermissionOption[]): boolean {
  if (response.outcome.outcome !== "selected") return false;
  const id = response.outcome.optionId;
  return options.find((o) => o.optionId === id)?.kind.startsWith("allow") ?? false;
}

/** One line for the notification: the command, or the file, or the tool's own title. */
function permissionSummary(parsed: ParsedPermission, req: acp.RequestPermissionRequest): string {
  const clip = (text: string) => (text.length > 90 ? `${text.slice(0, 89)}…` : text);
  if (parsed.variant === "execute") return clip(parsed.command);
  if (parsed.variant === "edit") return path.basename(parsed.path);
  return clip(req.toolCall.title ?? "");
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
