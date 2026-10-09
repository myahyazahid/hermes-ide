// Orchestrates one Hermes ACP process for the workspace: lifecycle (F-01..F-03, F-11), the chat
// transcript (F-06, F-07), permission cards (F-08), diff review (F-09), Stop (F-10) and the
// Custom API page (F-04, F-05). The webview and status bar only render what this class publishes.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import type * as acp from "@agentclientprotocol/sdk";
import { AcpClient, type HermesModelState } from "../core/acpClient";
import { CommandAllowlist, dangerousReason } from "../core/commandPolicy";
import { testConnection } from "../core/connectionTest";
import {
  buildLaunchEnv, buildProfileConfigYaml, defaultHermesHome, maskKey, readHermesModelConfig, shortModelName,
  validateCustomEndpoint, type CustomEndpoint, type EndpointMode,
} from "../core/endpoint";
import { isSupportedVersion, locateHermes, readHermesVersion, SUPPORTED_HERMES } from "../core/hermesLocator";
import { applyHunks, computeHunks, diffStat, sameText } from "../core/hunks";
import { cancelled, parsePermission, pickOption, selected, type ParsedPermission } from "../core/permission";
import { Transcript } from "../core/transcript";
import type { HostToView, ModelOption, PermissionAction, TranscriptItem, ViewState, ViewToHost } from "../shared/protocol";
import { resolveLocale, t, type Locale, type StringKey } from "../shared/strings";
import type { AgentLog } from "./agentLog";
import type { DiffReviewManager } from "./diffReview";

const SECRET_KEY = "hermes.endpoint.apiKey";
const ALLOWLIST_KEY = "hermes.allowlist";
const PREFERRED_MODEL_KEY = "hermes.preferredModel";
const LAST_SESSION_KEY = "hermes.lastSessionId";

interface PendingPermission {
  itemId: string;
  parsed: ParsedPermission;
  options: acp.PermissionOption[];
  respond(response: acp.RequestPermissionResponse): void;
  reviewId?: string;
  absPath?: string;
}

export class HermesService implements vscode.Disposable {
  private client: AcpClient | undefined;
  private hermesPath: string | undefined;
  private starting: Promise<boolean> | undefined;
  private transcript = new Transcript();
  private readonly pending = new Map<string, PendingPermission>();
  private readonly notesForNextPrompt: string[] = [];
  private suppressUpdates = false;
  private seq = 0;
  private post: ((msg: HostToView) => void) | undefined;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private availableModels: HermesModelState["availableModels"] = [];
  private readonly stateChanged = new vscode.EventEmitter<ViewState>();
  readonly onDidChangeState = this.stateChanged.event;
  private readonly disposables: vscode.Disposable[] = [this.stateChanged];
  state: ViewState;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: AgentLog,
    private readonly reviews: DiffReviewManager,
  ) {
    this.state = {
      phase: "checking",
      busy: false,
      models: [],
      endpoint: { mode: "hermes", baseUrl: "", model: "", keyHint: "", hasKey: false, contextLength: 0 },
      test: { running: false },
    };
    this.disposables.push(
      vscode.workspace.onDidGrantWorkspaceTrust(() => void this.refresh()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.restartForWorkspaceChange()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("hermes.path")) void this.restartForWorkspaceChange();
        else if (e.affectsConfiguration("hermes.language")) this.sendInit();
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
        return this.send(msg.text);
      case "stop":
        return this.stop();
      case "newSession":
        return this.newSession();
      case "permission":
        return this.handlePermissionAction(msg.id, msg.action);
      case "selectModel":
        return this.selectModel(msg.modelId);
      case "saveEndpoint":
        return this.saveEndpoint(msg);
      case "testEndpoint":
        return this.testEndpoint(msg);
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
    await this.loadEndpointView();
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

    const mode = this.endpointMode();
    if (mode === "custom" && validateCustomEndpoint(this.customEndpointSettings())) {
      return this.setState({ phase: "needsSetup", phaseDetail: undefined });
    }
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
    const mode = this.endpointMode();
    try {
      const env = await this.launchEnv(mode);
      const client = await AcpClient.start(
        { command: this.hermesPath, cwd, env },
        {
          onSessionUpdate: (n) => this.onSessionUpdate(n),
          onPermission: (req) => this.onPermission(req),
          onLog: (line) => this.log.hermes(line),
          onExit: (info) => this.onExit(client, info),
        },
        { name: "hermes-ide", version: String(this.context.extension.packageJSON.version ?? "0.0.0") },
      );
      this.client = client;
      this.log.info(`hermes acp started (pid ${client.pid}, mode ${mode}, cwd ${cwd})`);

      const method = (client.init?.authMethods ?? []).find((m) => !("type" in m && m.type === "terminal"));
      const authed = method ? await client.authenticate(method.id).catch(() => null) : null;
      if (!authed) {
        this.log.info("hermes has no configured provider (authenticate failed)");
        await client.stop();
        this.client = undefined;
        this.setState({ phase: "needsSetup", phaseDetail: mode === "hermes" ? this.tr("banner.notConfigured") : undefined });
        return false;
      }

      let models: HermesModelState | null | undefined;
      let sessionId: string | undefined;
      if (resumeSessionId) {
        this.suppressUpdates = true; // the transcript is still in memory; skip Hermes' replay
        try {
          const loaded = await client.loadSession(cwd, resumeSessionId);
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
        const created = await client.newSession(cwd);
        sessionId = created.sessionId;
        models = created.models;
        if (resumeSessionId) this.resetTranscript();
      }
      await this.context.workspaceState.update(LAST_SESSION_KEY, sessionId);
      await this.pinAskMode(client, sessionId);
      this.applyModels(models);
      this.setState({ phase: "ready", sessionId, busy: false });
      await this.applyPreferredModel();
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
    this.cancelAllPending();
    this.transcript.endTurn();
    this.scheduleFlush();
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

  private async restartForWorkspaceChange(): Promise<void> {
    await this.shutdown();
    this.resetTranscript();
    this.setState({ sessionId: undefined });
    await this.refresh();
  }

  async shutdown(): Promise<void> {
    const client = this.client;
    this.cancelAllPending();
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

  async send(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || this.state.busy) return;
    if (!(await this.ensureStarted()) || !this.client || !this.state.sessionId) return;

    this.transcript.addUser(trimmed);
    this.scheduleFlush();
    const notes = this.notesForNextPrompt.splice(0);
    const body = notes.length ? `${notes.join("\n")}\n\n${trimmed}` : trimmed;
    this.setState({ busy: true });
    const client = this.client;
    try {
      const res = await client.prompt(this.state.sessionId, [{ type: "text", text: body }]);
      if (res.stopReason === "cancelled") this.notice("info", this.tr("notice.stopped"));
      else if (res.stopReason === "refusal") this.notice("warn", "refusal");
    } catch (error) {
      if (client.isAlive) this.notice("error", this.tr("notice.promptFailed", (error as Error).message));
    } finally {
      this.transcript.endTurn();
      this.scheduleFlush();
      this.setState({ busy: false });
    }
  }

  /** F-10: cancels the running turn; ACP requires pending permission requests to be cancelled too. */
  async stop(): Promise<void> {
    if (!this.client || !this.state.sessionId || !this.state.busy) return;
    this.client.cancel(this.state.sessionId);
    this.cancelAllPending();
  }

  async newSession(): Promise<void> {
    if (this.state.busy) await this.stop();
    if (!(await this.ensureStarted()) || !this.client) return;
    try {
      const created = await this.client.newSession(this.cwd!);
      await this.context.workspaceState.update(LAST_SESSION_KEY, created.sessionId);
      await this.pinAskMode(this.client, created.sessionId);
      this.notesForNextPrompt.length = 0;
      this.resetTranscript();
      this.applyModels(created.models);
      this.setState({ sessionId: created.sessionId, sessionTitle: undefined, usage: undefined });
      await this.applyPreferredModel();
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
      if (this.endpointMode() === "hermes") await this.context.globalState.update(PREFERRED_MODEL_KEY, modelId);
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
      return { id: m.modelId, label: (shortCounts.get(s) ?? 0) > 1 ? m.name : s };
    });
    const current = models?.currentModelId;
    if (current && !options.some((o) => o.id === current)) {
      options.unshift({ id: current, label: shortModelName(current, this.availableModels) });
    }
    this.setState({ models: options, currentModelId: current });
  }

  /** Mode "hermes": re-applies the model the user last picked (e.g. customer-service). */
  private async applyPreferredModel(): Promise<void> {
    if (this.endpointMode() !== "hermes") return;
    const preferred = this.context.globalState.get<string>(PREFERRED_MODEL_KEY);
    if (!preferred || preferred === this.state.currentModelId) return;
    if (!this.availableModels.some((m) => m.modelId === preferred)) return;
    await this.selectModel(preferred);
  }

  private onSessionUpdate(n: acp.SessionNotification): void {
    if (this.suppressUpdates || n.sessionId !== this.state.sessionId) return;
    const effects = this.transcript.apply(n.update);
    if (effects.usage) this.setState({ usage: effects.usage });
    if (effects.title) this.setState({ sessionTitle: effects.title });
    this.scheduleFlush();
  }

  // ---- permissions (F-08, F-09) -------------------------------------------------------------

  private onPermission(req: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const parsed = parsePermission(req);
    const itemId = `perm:${++this.seq}`;
    this.log.info(`permission request ${itemId}: ${parsed.variant} ${JSON.stringify(req.options.map((o) => o.optionId))}`);

    return new Promise((resolve) => {
      let settled = false;
      const respond = (response: acp.RequestPermissionResponse) => {
        if (settled) return;
        settled = true;
        this.pending.delete(itemId);
        resolve(response);
      };
      const entry: PendingPermission = { itemId, parsed, options: req.options, respond };

      if (parsed.variant === "execute") {
        const danger = dangerousReason(parsed.command);
        const base = { kind: "permission" as const, id: itemId, variant: "execute" as const, title: this.tr("perm.execute"), command: parsed.command };
        if (!danger && this.allowlist().allows(parsed.command)) {
          this.transcript.upsert({ ...base, actions: [], state: "allowed", resolution: this.tr("perm.autoAllowed") });
          this.scheduleFlush();
          respond(selected(pickOption(req.options, "allow_once")));
          return;
        }
        const actions: PermissionAction[] = danger ? ["allow_once", "reject"] : ["allow_once", "allow_always_ws", "reject"];
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
    switch (action) {
      case "allow_once":
        return this.resolveCard(entry, selected(pickOption(entry.options, "allow_once")), "allowed", this.tr("perm.allowed"));
      case "allow_session":
        return this.resolveCard(entry, selected(pickOption(entry.options, "allow_session")), "allowed", this.tr("perm.allowedSession"));
      case "allow_always_ws": {
        // Stored per workspace by the IDE; Hermes only gets allow_once so its global allowlist is untouched.
        if (entry.parsed.variant === "execute") {
          const list = this.allowlist();
          if (list.add(entry.parsed.command)) await this.context.workspaceState.update(ALLOWLIST_KEY, list.toJSON());
        }
        return this.resolveCard(entry, selected(pickOption(entry.options, "allow_once")), "allowed", this.tr("perm.allowedAlways"));
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

  private cancelAllPending(): void {
    for (const entry of [...this.pending.values()]) {
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
      if (!this.state.busy) {
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

  // ---- endpoint (F-04, F-05) ----------------------------------------------------------------

  private endpointMode(): EndpointMode {
    return vscode.workspace.getConfiguration("hermes").get<string>("endpoint.mode") === "custom" ? "custom" : "hermes";
  }

  private customEndpointSettings(apiKey?: string): CustomEndpoint {
    const cfg = vscode.workspace.getConfiguration("hermes");
    return {
      baseUrl: cfg.get<string>("endpoint.baseUrl") ?? "",
      model: cfg.get<string>("endpoint.model") ?? "",
      contextLength: cfg.get<number>("endpoint.contextLength") ?? 0,
      apiKey,
    };
  }

  private async loadEndpointView(): Promise<void> {
    const key = await this.context.secrets.get(SECRET_KEY);
    this.log.setSecrets([key]);
    const custom = this.customEndpointSettings();
    const home = defaultHermesHome();
    const configPath = path.join(home, "config.yaml");
    const hermesConfig = { ...readHermesModelConfig(await readFile(configPath, "utf8").catch(() => "")), path: configPath };
    this.setState({
      endpoint: {
        mode: this.endpointMode(), baseUrl: custom.baseUrl, model: custom.model, contextLength: custom.contextLength ?? 0,
        keyHint: maskKey(key), hasKey: !!key, hermesConfig,
      },
    });
  }

  private async launchEnv(mode: EndpointMode): Promise<NodeJS.ProcessEnv> {
    if (mode !== "custom") return buildLaunchEnv({ parentEnv: process.env, mode });
    const custom = this.customEndpointSettings(await this.context.secrets.get(SECRET_KEY));
    const profileHome = path.join(this.context.globalStorageUri.fsPath, "hermes-home");
    await mkdir(profileHome, { recursive: true });
    const configPath = path.join(profileHome, "config.yaml");
    const yaml = buildProfileConfigYaml(custom);
    if ((await readFile(configPath, "utf8").catch(() => "")) !== yaml) await writeFile(configPath, yaml, "utf8");
    return buildLaunchEnv({ parentEnv: process.env, mode, custom, profileHome });
  }

  private async saveEndpoint(msg: Extract<ViewToHost, { type: "saveEndpoint" }>): Promise<void> {
    if (msg.mode === "custom") {
      const invalid = validateCustomEndpoint({ baseUrl: msg.baseUrl, model: msg.model });
      if (invalid) {
        this.setState({ test: { running: false, ok: false, message: this.tr(`test.fail.${invalid}` as StringKey) } });
        return;
      }
    }
    const cfg = vscode.workspace.getConfiguration("hermes");
    const target = vscode.ConfigurationTarget.Global;
    await cfg.update("endpoint.mode", msg.mode, target);
    await cfg.update("endpoint.baseUrl", msg.baseUrl.trim(), target);
    await cfg.update("endpoint.model", msg.model.trim(), target);
    await cfg.update("endpoint.contextLength", Math.max(0, Math.floor(msg.contextLength || 0)), target);
    if (msg.apiKey !== undefined) {
      if (msg.apiKey === "") await this.context.secrets.delete(SECRET_KEY);
      else await this.context.secrets.store(SECRET_KEY, msg.apiKey.trim());
    }
    this.log.info(`endpoint saved (mode ${msg.mode}, base ${msg.baseUrl || "-"}, model ${msg.model || "-"})`);
    // A different endpoint means a different Hermes home or provider: start clean.
    await this.shutdown();
    this.resetTranscript();
    this.setState({ sessionId: undefined, models: [], currentModelId: undefined, usage: undefined });
    await this.refresh();
  }

  private async testEndpoint(msg: Extract<ViewToHost, { type: "testEndpoint" }>): Promise<void> {
    this.setState({ test: { running: true } });
    if (!msg.baseUrl.trim()) {
      // Mode "hermes": check that Hermes itself can open a session with its own config.
      const ok = await this.ensureStarted();
      if (!ok || !this.client) {
        this.setState({ test: { running: false, ok: false, message: this.state.phaseDetail ?? this.tr("status.crashed") } });
        return;
      }
      const t0 = Date.now();
      try {
        await this.client.newSession(this.cwd!);
        const label = shortModelName(this.state.currentModelId, this.availableModels) || this.tr("composer.noModel");
        this.setState({ test: { running: false, ok: true, message: this.tr("test.hermesOk", label, Date.now() - t0) } });
      } catch (error) {
        this.setState({ test: { running: false, ok: false, message: (error as Error).message } });
      }
      return;
    }

    const apiKey = msg.apiKey !== undefined && msg.apiKey !== "" ? msg.apiKey : await this.context.secrets.get(SECRET_KEY);
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

  dispose(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    void this.shutdown();
    for (const d of this.disposables) d.dispose();
  }
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

