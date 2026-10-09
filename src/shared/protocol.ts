// Messages and view models shared by the extension host and the chat webview.
// No runtime imports: this file is compiled into both bundles.

export type Phase =
  | "checking" // locating hermes / reading config
  | "missing" // hermes not installed
  | "untrusted" // workspace not trusted
  | "noWorkspace"
  | "needsSetup" // custom mode without a valid endpoint
  | "starting"
  | "ready"
  | "crashed"
  | "stopped";

export type ToolStatus = "pending" | "in_progress" | "completed" | "failed";

export type TranscriptItem =
  | { kind: "user"; id: string; text: string }
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
}

export interface EndpointView {
  mode: "hermes" | "custom";
  baseUrl: string;
  model: string;
  keyHint: string;
  hasKey: boolean;
  contextLength: number;
  /** What the user's own Hermes config says (mode "hermes"). */
  hermesConfig?: { provider?: string; baseUrl?: string; model?: string; path: string };
}

export interface TestView {
  running: boolean;
  ok?: boolean;
  /** Already translated, ready to show. */
  message?: string;
  detail?: string;
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
  hermesVersion?: string;
  versionWarning?: string;
  usage?: { used: number; size: number };
}

export type HostToView =
  | { type: "init"; locale: "id" | "en"; state: ViewState; items: TranscriptItem[] }
  | { type: "state"; state: ViewState }
  | { type: "items"; items: TranscriptItem[] } // upserts by id, keeps order of first appearance
  | { type: "reset"; items: TranscriptItem[] }
  | { type: "focusComposer" }
  | { type: "openEndpoint" };

export type ViewToHost =
  | { type: "ready" }
  | { type: "send"; text: string }
  | { type: "stop" }
  | { type: "newSession" }
  | { type: "permission"; id: string; action: PermissionAction }
  | { type: "selectModel"; modelId: string }
  | {
      type: "saveEndpoint";
      mode: "hermes" | "custom";
      baseUrl: string;
      model: string;
      /** undefined = keep the stored key; "" = remove it. */
      apiKey?: string;
      contextLength: number;
    }
  | { type: "testEndpoint"; baseUrl: string; model: string; apiKey?: string; contextLength: number }
  | { type: "restart" }
  | { type: "recheck" }
  | { type: "openFile"; path: string }
  | { type: "showLog" }
  | { type: "trustWorkspace" };
