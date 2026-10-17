// One HermesService per open chat panel, like Claude Code's one session per panel: each panel runs its own Hermes
// process and session, while the history stays shared (every service lists the same Hermes sessions). Commands
// that are not tied to a panel (status bar, Stop, Add to chat, the Sessions tree) go to the panel used last.
import * as vscode from "vscode";
import type { ViewState } from "../shared/protocol";
import type { Locale } from "../shared/strings";
import type { HermesService } from "./hermesService";
import type { SessionsSource, SessionSummary } from "./sessionsView";

export class ChatHub implements SessionsSource, vscode.Disposable {
  private readonly subscriptions = new Map<HermesService, vscode.Disposable[]>();
  private current: HermesService;
  private readonly stateChanged = new vscode.EventEmitter<ViewState>();
  private readonly sessionsChanged = new vscode.EventEmitter<void>();
  /** The active panel's state: on its own changes and when another panel becomes the active one. */
  readonly onDidChangeState = this.stateChanged.event;
  /** Any panel's session list changed (new, renamed, busy, closed). */
  readonly onDidChangeSessions = this.sessionsChanged.event;

  /** `primary` lives as long as the extension; the others live as long as their panel. */
  constructor(readonly primary: HermesService) {
    this.current = primary;
    this.track(primary);
  }

  get active(): HermesService {
    return this.current;
  }

  get locale(): Locale {
    return this.current.locale;
  }

  all(): HermesService[] {
    return [...this.subscriptions.keys()];
  }

  /** The service for a panel that just opened: the primary one while no panel shows it, else a new one. */
  acquire(): HermesService {
    if (!this.primary.hasViews) return this.primary;
    const service = this.primary.createSibling();
    this.track(service);
    void service.refresh();
    return service;
  }

  /** A panel closed: its own service stops its Hermes process; the primary one stays for the next panel. */
  release(service: HermesService): void {
    if (service === this.primary || service.hasViews || !this.subscriptions.has(service)) return;
    for (const d of this.subscriptions.get(service) ?? []) d.dispose();
    this.subscriptions.delete(service);
    service.dispose();
    if (this.current === service) this.touch(this.all().find((s) => s.hasViews) ?? this.primary);
    this.sessionsChanged.fire();
  }

  /** The user is working in this panel now. */
  touch(service: HermesService): void {
    if (this.current === service || !this.subscriptions.has(service)) return;
    this.current = service;
    this.stateChanged.fire(service.state);
    this.sessionsChanged.fire();
  }

  // ---- the Sessions tree ----------------------------------------------------------------------

  listSessions(): Promise<SessionSummary[]> {
    return this.current.listSessions();
  }

  /** Whether a session runs in some panel right now, and if so whether it is busy. */
  liveState(sessionId: string): "running" | "open" | undefined {
    const owner = this.all().find((s) => s.currentSessionId === sessionId);
    if (!owner) return undefined;
    return owner.busy ? "running" : "open";
  }

  private track(service: HermesService): void {
    this.subscriptions.set(service, [
      service.onDidChangeState((s) => {
        if (service === this.current) this.stateChanged.fire(s);
      }),
      service.onDidChangeSessions(() => this.sessionsChanged.fire()),
    ]);
  }

  dispose(): void {
    for (const service of this.all()) {
      for (const d of this.subscriptions.get(service) ?? []) d.dispose();
      // The primary service is disposed with the extension's subscriptions.
      if (service !== this.primary) service.dispose();
    }
    this.subscriptions.clear();
    this.stateChanged.dispose();
    this.sessionsChanged.dispose();
  }
}
