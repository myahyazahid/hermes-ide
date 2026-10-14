// Messages and view models shared by the extension host and the chat webview.
// No runtime imports: this file is compiled into both bundles.

export type Phase =
  | "checking" // locating hermes / reading config
  | "missing" // hermes not installed
  | "untrusted" // workspace not trusted
  | "noWorkspace"
  | "needsSetup" // custom profile without a valid endpoint
  | "starting"
  | "ready"
  | "crashed"
  | "stopped";

export type ToolStatus = "pending" | "in_progress" | "completed" | "failed";

/** F-12: something attached to a prompt with @file, @folder or a selection. */
export interface ContextRef {
  /** "codebase" = semantic search over the index with the prompt text (F-18). */
  kind: "file" | "folder" | "selection" | "codebase" | "image";
  /** Absolute path; for a pasted image, just its display name ("image.png"). */
  path: string;
  /** 1-based, selections only. */
  startLine?: number;
  endLine?: number;
  text?: string;
  /** Pasted images only: base64 bytes (no data: prefix) and pixel size. */
  data?: string;
  mimeType?: string;
  width?: number;
  height?: number;
}

export type TranscriptItem =
  | {
      kind: "user";
      id: string;
      text: string;
      at?: number;
      context?: { label: string; path: string; kind?: ContextRef["kind"] | "rules" }[];
      /** 0-based count of user messages in the session; the key checkpoints are stored under. */
      turn?: number;
      /** The agent changed files during this turn and "Restore to here" can put them back. */
      restorable?: boolean;
      /** A terminal command ran during this turn; its effect on files is not covered by a restore. */
      ranCommands?: boolean;
    }
  | { kind: "agent"; id: string; text: string; streaming: boolean; at?: number }
  /** startedAt/endedAt: first and latest chunk, for "Thought for 3s". */
  | { kind: "thought"; id: string; text: string; startedAt?: number; endedAt?: number }
  | {
      kind: "tool";
      id: string;
      title: string;
      toolKind: string;
      status: ToolStatus;
      startedAt: number;
      endedAt?: number;
      paths: string[];
      added?: number;
      removed?: number;
      /** What the tool was called with (the command for terminal tools), shown as IN. */
      input?: string;
      /** The agent's one-line reason for the call, if it gave one. */
      description?: string;
      /** Tool output, shown as OUT. */
      detail?: string;
    }
  | {
      kind: "permission";
      id: string;
      variant: "execute" | "edit" | "other";
      title: string;
      command?: string;
      path?: string;
      paths?: string[];
      added?: number;
      removed?: number;
      dangerReason?: string;
      /** Learning mode: what the agent last said before asking, as its reason. */
      why?: string;
      /** Which buttons to render; derived from the options Hermes offered. */
      actions: PermissionAction[];
      state: "pending" | "allowed" | "rejected" | "cancelled";
      resolution?: string;
    }
  | { kind: "notice"; id: string; level: "info" | "warn" | "error"; text: string };

export type PermissionAction = "allow_once" | "allow_session" | "allow_always_ws" | "reject" | "review";

export interface ModelOption {
  id: string;
  label: string;
  /** Full local mode is on and this model is served from the internet, so it cannot be picked. */
  blocked?: boolean;
  /** Provider or endpoint the model is served by, e.g. "Anthropic" or "Router.redscale.my.id". */
  group: string;
}

/** F-16: the built-in "Hermes config" profile (id "hermes") plus named custom endpoints. */
export interface ProfileView {
  id: string;
  name: string;
  kind: "hermes" | "custom";
  baseUrl: string;
  model: string;
  contextLength: number;
  keyHint: string;
  hasKey: boolean;
}

export interface EndpointView {
  activeProfileId: string;
  profiles: ProfileView[];
  /** What the user's own Hermes config says (profile "hermes"). */
  hermesConfig?: { provider?: string; baseUrl?: string; model?: string; path: string };
}

export interface TestView {
  running: boolean;
  ok?: boolean;
  /** Already translated, ready to show. */
  message?: string;
  detail?: string;
}

/** User story 4: whether every terminal command goes through a permission card. */
export type TerminalApprovalState =
  | "active"
  | "needsConsent" // Hermes-config profile: the hook must be added to the user's config first
  | "dismissed" // user chose "later"; only commands Hermes considers risky ask
  | "disabled" // setting off
  | "unavailable"; // no Node runtime found for the hook

export interface McpServerView {
  name: string;
  type: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  url?: string;
  enabled: boolean;
}

/** F-17 Tab autocomplete settings and health. */
export interface CompletionView {
  enabled: boolean;
  baseUrl: string;
  model: string;
  template: string;
  keyHint: string;
  hasKey: boolean;
  avgLatencyMs?: number;
  lastError?: string;
  /** Full local mode is on and the endpoint is not local, so completions are off. */
  blocked?: boolean;
}

/** F-18 codebase index settings and progress. */
export interface IndexView {
  enabled: boolean;
  baseUrl: string;
  model: string;
  keyHint: string;
  hasKey: boolean;
  status: "disabled" | "needsSetup" | "idle" | "indexing" | "ready" | "error";
  files: number;
  chunks: number;
  done?: number;
  total?: number;
  error?: string;
  /** Full local mode is on and the endpoint is not local, so the index is off. */
  blocked?: boolean;
}

/** Who approves what (Claude-style modes); applied by the IDE, Hermes itself stays in "default". */
export type AgentMode = "manual" | "acceptEdits" | "plan" | "ask" | "auto" | "superAuto";

/** Automatic model routing settings (phase 6). */
export interface RoutingView {
  enabled: boolean;
  lightModel: string;
  heavyModel: string;
  fallbackModel: string;
  lightMaxChars: number;
}

/** A server the user registered for deploying (phase 7). Holds a key file's path, never a secret. */
export interface DeployTargetView {
  name: string;
  host: string;
  user: string;
  port?: number;
  identityFile?: string;
  path?: string;
  gitRemote?: string;
  steps?: string;
}

export interface DeployPanel {
  targets: DeployTargetView[];
  /** Already translated: why deploying is not possible right now. */
  blocked?: string;
  /** The server whose connection is being checked. */
  checking?: string;
  /** Result of the last connection check per server name, already translated. */
  results: Record<string, { ok: boolean; text: string }>;
  historyCount: number;
  notice?: { level: "ok" | "error"; text: string };
}

/** A supported stack and where the project stands with it (phase 7). */
export interface StackView {
  id: "laravel" | "filament" | "flutter" | "nextjs";
  label: string;
  /** The project looks like this stack. */
  detected: boolean;
  /** Its rules pack is already in .hermes/rules. */
  added: boolean;
  /** The user said "later" to the suggestion. */
  dismissed: boolean;
}

/** Languages (phase 7): the panel's and the agent's, set apart. */
export interface LanguageView {
  ui: "auto" | "id" | "en";
  agent: "ui" | "id" | "en" | "off";
}

/** Learning mode (phase 7): the agent explains every change and why. */
export interface LearningView {
  on: boolean;
  level: "beginner" | "intermediate";
}

/** Hermes' curated memory files (phase 6). */
export type MemoryTarget = "memory" | "user";

export interface MemoryTargetView {
  target: MemoryTarget;
  path: string;
  entries: string[];
  limit: number;
  /** Characters the entries take once joined, the number Hermes counts against the limit. */
  used: number;
  /** Hermes lets the user switch either file off in its config.yaml. */
  enabled: boolean;
  /** Fingerprint of the file as read, so a save can tell that it changed in between. */
  hash: string;
  /** The file holds something other than a clean list: saving rewrites it. */
  irregular: boolean;
}

export interface MemoryPanel {
  home: string;
  targets: MemoryTargetView[];
  /** Already translated result of the last save. */
  notice?: { level: "ok" | "error"; text: string };
}

/** A skill found by `hermes skills search` (phase 6). */
export interface SkillHitView {
  name: string;
  /** What `hermes skills install` takes, e.g. "official/devops/watchers". */
  identifier: string;
  source: string;
  trust: string;
  description: string;
}

export interface InstalledSkillView {
  name: string;
  category: string;
  /** "local", "builtin" or the registry a hub skill came from. */
  source: string;
  trust: string;
  enabled: boolean;
}

export interface SkillsPanel {
  installed: InstalledSkillView[];
  results: SkillHitView[];
  /** The query the results belong to; undefined before the first search. */
  query?: string;
  /** What Hermes is being asked right now. */
  working?: "list" | "search" | "install" | "uninstall";
  /** Already translated: searching and installing are switched off (full local mode). */
  blocked?: string;
  notice?: { level: "ok" | "error"; text: string };
}

/** One parallel agent task (phase 6): its own Hermes in its own git worktree. */
export type TaskStatus = "starting" | "running" | "done" | "failed" | "stopped" | "interrupted";

export interface TaskView {
  id: string;
  title: string;
  status: TaskStatus;
  branch: string;
  createdAt: number;
  finishedAt?: number;
  allowCommands: boolean;
  /** Changed files (at most 30 names; the count is `fileCount`). */
  files: string[];
  fileCount: number;
  additions: number;
  deletions: number;
  /** What the agent said last, as its summary. */
  summary?: string;
  /** The tool it is using right now. */
  activity?: string;
  /** Requests the task policy refused, newest last (at most 10). */
  denied: { reason: string; subject: string }[];
  deniedCount: number;
  error?: string;
  applied: boolean;
  /** The conversation is still in memory (it is not kept across a restart of the IDE). */
  hasChat: boolean;
}

export interface TasksPanel {
  tasks: TaskView[];
  maxParallel: number;
  /** Already translated: why a new task cannot start right now. */
  blocked?: string;
  notice?: { level: "ok" | "error"; text: string };
}

/** Full local mode (phase 6). */
export interface PrivacyView {
  localOnly: boolean;
  allowedHosts: string[];
  /** Already translated: why the agent may not run right now. Undefined when it may. */
  blocked?: string;
  /** The block is only the missing hook, which the user can install from the panel (profile "hermes"). */
  needsGuard: boolean;
}

/** Project rules currently found in the workspace (phase 5). */
export interface RulesView {
  /** Workspace-relative paths. */
  files: string[];
  bytes: number;
  truncated: boolean;
}

/** Token and cost totals for the current session (phase 5). */
export interface UsageView {
  input: number;
  output: number;
  thought: number;
  cached: number;
  turns: number;
  /** Estimated from the user's own prices; undefined when no model of the session has a price. */
  cost?: number;
  currency: string;
  /** Some model in this session has no price, so `cost` is a lower bound. */
  unpriced: boolean;
}

export interface ViewState {
  phase: Phase;
  mode: AgentMode;
  phaseDetail?: string;
  /** Workspace folder Hermes runs in (F-03); used to show relative paths. */
  cwd?: string;
  busy: boolean;
  sessionId?: string;
  sessionTitle?: string;
  models: ModelOption[];
  currentModelId?: string;
  endpoint: EndpointView;
  test: TestView;
  terminalApproval: TerminalApprovalState;
  mcpServers: McpServerView[];
  mcpError?: string;
  completion: CompletionView;
  completionTest?: TestView;
  index: IndexView;
  indexTest?: TestView;
  hermesVersion?: string;
  versionWarning?: string;
  /** Where the installed Hermes sits relative to the versions this IDE was tested with. */
  hermesStatus?: "tested" | "newer" | "older";
  hermesUpdate?: "checking" | "available" | "current" | "unknown" | "updating";
  /** Context window use reported by Hermes. */
  usage?: { used: number; size: number };
  /** Token and cost totals of the session (phase 5). */
  sessionUsage?: UsageView;
  rules?: RulesView;
  privacy?: PrivacyView;
  routing?: RoutingView;
  language?: LanguageView;
  learning?: LearningView;
  stacks?: StackView[];
  /** The hook is asking about every terminal command (it may be installed only for local mode). */
  asksEveryCommand?: boolean;
  /** The last "restore to here" can still be undone. */
  canUndoRestore?: boolean;
  /** Show the quick-start card in an empty chat. */
  onboarding?: boolean;
  /** Whether the Hermes install can be started from the panel (Windows only). */
  canInstallHermes?: boolean;
  /** Messages typed while the agent works; they go out together when the turn ends. */
  queued?: QueuedView[];
}

export interface QueuedView {
  id: string;
  text: string;
  /** Number of context chips sent with it. */
  attachments: number;
}

export interface MentionItem {
  kind: "file" | "folder" | "codebase";
  path: string;
  /** Workspace-relative display path. */
  label: string;
}

export type HostToView =
  | { type: "init"; locale: "id" | "en"; state: ViewState; items: TranscriptItem[] }
  | { type: "state"; state: ViewState }
  | { type: "items"; items: TranscriptItem[] } // upserts by id, keeps order of first appearance
  | { type: "reset"; items: TranscriptItem[] }
  | { type: "focusComposer" }
  | { type: "openEndpoint" }
  | { type: "addContext"; ref: ContextRef }
  | { type: "mentionResults"; requestId: number; items: MentionItem[] }
  | { type: "sessions"; requestId: number; sessions: SessionView[] }
  | { type: "memory"; panel: MemoryPanel }
  | { type: "skills"; panel: SkillsPanel }
  | { type: "tasks"; panel: TasksPanel }
  | { type: "endpointModels"; baseUrl: string; models: string[]; error?: string }
  | { type: "deploy"; panel: DeployPanel }
  | { type: "insertPrompt"; text: string };

/** A row in the chat panel's session history popover (F-14). */
export interface SessionView {
  id: string;
  title: string;
  /** Epoch ms of the last activity, if Hermes reported it. */
  updatedAt?: number;
  current: boolean;
}

export interface ProfileInput {
  /** Omitted for a new profile. */
  id?: string;
  name: string;
  baseUrl: string;
  model: string;
  contextLength: number;
}

export type ViewToHost =
  | { type: "ready" }
  | { type: "send"; text: string; context?: ContextRef[] }
  | { type: "stop" }
  /** Sends the queued messages now, stopping the running turn first. */
  | { type: "sendQueued" }
  /** Drops a queued message; with `edit`, it goes back to the composer. */
  | { type: "unqueue"; id: string; edit?: boolean }
  | { type: "newSession" }
  /** Composer "+" / "/attach": file picker, picked files come back as addContext. */
  | { type: "attachFile" }
  | { type: "setMode"; mode: AgentMode }
  | { type: "exportConversation" }
  | { type: "listSessions"; requestId: number }
  | { type: "openSession"; id: string; title?: string }
  /** Asks for confirmation on the host, then answers with a fresh "sessions" list. */
  | { type: "deleteSession"; id: string; title: string; requestId: number }
  | { type: "permission"; id: string; action: PermissionAction }
  | { type: "selectModel"; modelId: string }
  | { type: "mentionQuery"; requestId: number; query: string }
  | { type: "selectProfile"; id: string }
  /** undefined apiKey = keep the stored key; "" = remove it. Activates the profile. */
  | { type: "saveProfile"; profile: ProfileInput; apiKey?: string }
  | { type: "deleteProfile"; id: string }
  | { type: "testEndpoint"; profileId?: string; baseUrl: string; model: string; apiKey?: string; contextLength: number }
  | { type: "enableTerminalApproval" }
  | { type: "dismissTerminalApproval" }
  | { type: "saveMcpServers"; servers: McpServerView[] }
  /** undefined apiKey = keep the stored key; "" = remove it. */
  | { type: "saveCompletion"; enabled: boolean; baseUrl: string; model: string; template: string; apiKey?: string }
  | { type: "testCompletion"; baseUrl: string; model: string; template: string; apiKey?: string }
  | { type: "saveIndex"; enabled: boolean; baseUrl: string; model: string; apiKey?: string }
  | { type: "testIndex"; baseUrl: string; model: string; apiKey?: string }
  | { type: "rebuildIndex" }
  | { type: "restart" }
  | { type: "recheck" }
  /** Phase 5. */
  | { type: "restoreCheckpoint"; turn: number }
  | { type: "undoRestore" }
  | { type: "openRules" }
  | { type: "showUsage" }
  | { type: "installHermes" }
  | { type: "runHermesSetup" }
  | { type: "checkHermesUpdate" }
  | { type: "updateHermes" }
  | { type: "dismissOnboarding" }
  /** Phase 6: full local mode. */
  | { type: "saveRouting"; routing: RoutingView }
  | { type: "loadDeploy" }
  | { type: "saveDeployTarget"; target: DeployTargetView; original?: string }
  | { type: "deleteDeployTarget"; name: string }
  | { type: "testDeployTarget"; name: string }
  | { type: "openSshTerminal"; name: string }
  | { type: "prepareDeploy"; name: string }
  | { type: "showDeployHistory" }
  | { type: "addStackRules"; id: StackView["id"] }
  | { type: "dismissStack"; id: StackView["id"] }
  | { type: "loadStacks" }
  | { type: "setLanguage"; ui?: LanguageView["ui"]; agent?: LanguageView["agent"] }
  | { type: "setLearning"; on?: boolean; level?: LearningView["level"] }
  | { type: "loadMemory" }
  | { type: "saveMemory"; target: MemoryTarget; entries: string[]; hash: string }
  | { type: "openMemoryFile"; target: MemoryTarget }
  | { type: "listModels"; baseUrl: string; apiKey?: string; profileId?: string }
  | { type: "openUrl"; url: string }
  | { type: "loadTasks" }
  | { type: "startTask"; prompt: string; allowCommands: boolean }
  | { type: "stopTask"; id: string }
  | { type: "viewTaskChanges"; id: string }
  | { type: "openTaskChat"; id: string }
  | { type: "applyTask"; id: string }
  | { type: "discardTask"; id: string }
  | { type: "openTaskFolder"; id: string }
  | { type: "loadSkills" }
  | { type: "searchSkills"; query: string }
  | { type: "inspectSkill"; identifier: string }
  | { type: "installSkill"; identifier: string; name: string; source: string; trust: string }
  | { type: "uninstallSkill"; name: string }
  | { type: "setLocalOnly"; enabled: boolean }
  | { type: "saveAllowedHosts"; hosts: string[] }
  | { type: "showPrivacy" }
  | { type: "openFile"; path: string }
  | { type: "showLog" }
  | { type: "trustWorkspace" };
