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
  kind: "file" | "folder" | "selection" | "codebase";
  /** Absolute path. */
  path: string;
  /** 1-based, selections only. */
  startLine?: number;
  endLine?: number;
  text?: string;
}

export type TranscriptItem =
  | { kind: "user"; id: string; text: string; context?: { label: string; path: string }[] }
  | { kind: "agent"; id: string; text: string; streaming: boolean }
  | { kind: "thought"; id: string; text: string }
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
}

export interface ViewState {
  phase: Phase;
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
  usage?: { used: number; size: number };
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
  | { type: "mentionResults"; requestId: number; items: MentionItem[] };

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
  | { type: "newSession" }
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
  | { type: "openFile"; path: string }
  | { type: "showLog" }
  | { type: "trustWorkspace" };
