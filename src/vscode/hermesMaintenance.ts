// Installing, checking and updating Hermes from the IDE (phase 5). See src/core/hermesMaintenance.ts for why updates are
// explicit and guarded instead of automatic.
import * as vscode from "vscode";
import { SUPPORTED_HERMES, TESTED_HERMES, locateHermes } from "../core/hermesLocator";
import { checkHermesUpdate, installCommand, updateHermes, versionStatus } from "../core/hermesMaintenance";
import type { ViewState } from "../shared/protocol";
import { t, type Locale, type StringKey } from "../shared/strings";
import type { AgentLog } from "./agentLog";
import { privacySettings } from "./privacyGate";

const LAST_CHECK_KEY = "hermes.hermesUpdate.lastCheck";
const CHECK_EVERY_MS = 7 * 24 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 60_000;
const INSTALL_POLL_MS = 4_000;
const INSTALL_GIVE_UP_MS = 20 * 60_000;

/** What the maintenance flows need from the service, kept narrow so they can be tested without it. */
export interface MaintenanceHost {
  locale(): Locale;
  hermesPath(): string | undefined;
  env(): NodeJS.ProcessEnv | undefined;
  version(): string | undefined;
  busy(): boolean;
  /** Stops the `hermes acp` process (a running Hermes keeps its files locked on Windows). */
  stopHermes(): Promise<void>;
  /** Re-detects Hermes and starts it again. */
  refresh(): Promise<void>;
  setUpdateStatus(status: ViewState["hermesUpdate"]): void;
  notice(level: "info" | "warn" | "error", text: string): void;
}

const testedRange = () => `>=${SUPPORTED_HERMES.min} <${SUPPORTED_HERMES.maxExclusive}`;

export class HermesMaintenance implements vscode.Disposable {
  private timers: ReturnType<typeof setTimeout>[] = [];
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: AgentLog,
    private readonly host: MaintenanceHost,
  ) {}

  private tr(key: StringKey, ...args: (string | number)[]): string {
    return t(this.host.locale(), key, ...args);
  }

  /** Runs a command in a visible terminal and calls `done` once it ends (or after a final check). */
  private runInTerminal(name: string, shellPath: string, shellArgs: string[], done: () => void | Promise<void>): vscode.Terminal {
    const terminal = vscode.window.createTerminal({ name, shellPath, shellArgs });
    terminal.show();
    const sub = vscode.window.onDidCloseTerminal(async (closed) => {
      if (closed !== terminal) return;
      sub.dispose();
      await done();
    });
    this.disposables.push(sub);
    return terminal;
  }

  // ---- install and setup wizard -------------------------------------------------------------

  /** Installs the tested Hermes build with the official installer, visibly, then re-detects it. */
  install(): void {
    if (process.platform !== "win32") {
      void vscode.window.showInformationMessage(this.tr("hermesMaint.installUnsupported"));
      return;
    }
    this.log.info(`installing Hermes ${TESTED_HERMES.version} (pinned ${TESTED_HERMES.commit.slice(0, 8)}) via the official installer`);
    this.runInTerminal("Hermes install", "powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", installCommand()], async () => {
      await this.host.refresh();
    });
    this.host.notice("info", this.tr("hermesMaint.installStarted"));
    // The installer may leave the terminal open at its end: notice Hermes as soon as it exists.
    const started = Date.now();
    const poll = setInterval(() => {
      const configured = vscode.workspace.getConfiguration("hermes").get<string>("path");
      if (locateHermes({ configuredPath: configured })) {
        clearInterval(poll);
        this.host.notice("info", this.tr("hermesMaint.installFound"));
        void this.host.refresh();
      } else if (Date.now() - started > INSTALL_GIVE_UP_MS) {
        clearInterval(poll);
      }
    }, INSTALL_POLL_MS);
    this.disposables.push(new vscode.Disposable(() => clearInterval(poll)));
  }

  /** Hermes' own interactive provider/model wizard, for people who use their Hermes config. */
  runSetupWizard(): void {
    const hermes = this.host.hermesPath();
    if (!hermes) {
      this.host.notice("warn", this.tr("hermesMaint.notFound"));
      return;
    }
    this.runInTerminal("Hermes model", hermes, ["model"], async () => {
      await this.host.refresh();
    });
    this.host.notice("info", this.tr("hermesMaint.wizardStarted"));
  }

  // ---- update -------------------------------------------------------------------------------

  /** At most one background check a week. It only ever informs; installing always needs the user's click. */
  scheduleBackgroundCheck(): void {
    if (!vscode.workspace.getConfiguration("hermes.hermesUpdate").get<boolean>("check", true)) return;
    const last = this.context.globalState.get<number>(LAST_CHECK_KEY) ?? 0;
    if (Date.now() - last < CHECK_EVERY_MS) return;
    this.timers.push(setTimeout(() => void this.checkUpdate(false), STARTUP_DELAY_MS));
  }

  async checkUpdate(userInitiated: boolean): Promise<void> {
    if (privacySettings().localOnly) {
      if (userInitiated) void vscode.window.showInformationMessage(this.tr("privacy.updates.off"));
      return;
    }
    const hermes = this.host.hermesPath();
    if (!hermes) {
      if (userInitiated) void vscode.window.showWarningMessage(this.tr("hermesMaint.notFound"));
      return;
    }
    this.host.setUpdateStatus("checking");
    if (userInitiated) this.host.notice("info", this.tr("hermesMaint.checking"));
    const result = await checkHermesUpdate(hermes, this.host.env());
    this.log.info(`hermes update --check: ${result.state}${result.behind ? ` (${result.behind} commits behind)` : ""} ${result.raw.replace(/\s+/g, " ").slice(0, 200)}`);
    this.host.setUpdateStatus(result.state);
    if (result.state !== "unknown") await this.context.globalState.update(LAST_CHECK_KEY, Date.now());

    if (result.state === "available") {
      const update = this.tr("hermesMaint.confirmButton");
      const choice = await vscode.window.showInformationMessage(this.tr("hermesMaint.available", this.host.version() ?? "?"), update);
      if (choice === update) await this.update();
    } else if (userInitiated) {
      if (result.state === "current") void vscode.window.showInformationMessage(this.tr("hermesMaint.current"));
      else void vscode.window.showWarningMessage(this.tr("hermesMaint.unknown", result.raw.split("\n").find((l) => l.trim()) ?? "?"));
    }
  }

  /** Asks first, backs up, stops Hermes, updates, then verifies the version it ended up with. */
  async update(): Promise<void> {
    if (privacySettings().localOnly) return void vscode.window.showInformationMessage(this.tr("privacy.updates.off"));
    const hermes = this.host.hermesPath();
    if (!hermes) return void vscode.window.showWarningMessage(this.tr("hermesMaint.notFound"));
    if (this.host.busy()) return void vscode.window.showWarningMessage(this.tr("hermesMaint.busy"));

    const before = this.host.version() ?? "?";
    const confirm = this.tr("hermesMaint.confirmButton");
    const answer = await vscode.window.showWarningMessage(
      this.tr("hermesMaint.confirmTitle"),
      { modal: true, detail: this.tr("hermesMaint.confirmDetail", before, testedRange()) },
      confirm,
    );
    if (answer !== confirm) return;

    this.host.setUpdateStatus("updating");
    this.host.notice("info", this.tr("hermesMaint.updating"));
    await this.host.stopHermes();
    this.log.info("hermes update --backup --yes: started");
    const run = await updateHermes(hermes, this.host.env(), (chunk) => {
      for (const line of chunk.split(/\r?\n/)) if (line.trim()) this.log.hermes(line);
    });
    this.log.info(`hermes update finished with code ${run.code ?? "none"}${run.timedOut ? " (timed out)" : ""}`);
    await this.host.refresh(); // re-reads the version and restarts Hermes, also after a failed update

    if (run.code !== 0) {
      this.host.setUpdateStatus("unknown");
      this.host.notice("error", this.tr("hermesMaint.updateFailed", run.code ?? "?"));
      return;
    }
    this.host.setUpdateStatus("current");
    const after = this.host.version() ?? "?";
    if (after !== "?" && versionStatus(after) !== "tested") this.host.notice("warn", this.tr("hermesMaint.updatedOutside", after, testedRange()));
    else this.host.notice("info", this.tr("hermesMaint.updated", after));
  }

  dispose(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    for (const d of this.disposables) d.dispose();
  }
}
