// In-IDE update for the standalone Hermes IDE (phase 4). Only active when product.json carries a `hermesIde` block,
// i.e. inside the packaged IDE; in plain VS Code the command just explains that. The only request made is a GET for
// the release feed, and it can be turned off with `hermes.update.check`.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { checkForUpdate, cleanLaunchEnv, downloadInstaller, INSTALLER_ARGS, parseIdeInfo, type IdeInfo, type UpdateInfo } from "../core/updater";
import { t, type Locale } from "../shared/strings";
import type { AgentLog } from "./agentLog";
import { privacySettings } from "./privacyGate";

const SKIPPED_KEY = "hermes.update.skippedVersion";
const STARTUP_DELAY_MS = 20_000;
const CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;

export interface IdeUpdaterDeps {
  /** Overrides what is read from product.json (tests). */
  info?: IdeInfo;
  fetchImpl?: typeof fetch;
  /** Starts the installer detached; resolves once the process exists. */
  launchInstaller?: (file: string, args: string[]) => Promise<void>;
  quit?: () => Thenable<unknown>;
  downloadDir?: string;
}

function readIdeInfo(): IdeInfo | undefined {
  try {
    return parseIdeInfo(JSON.parse(readFileSync(path.join(vscode.env.appRoot, "product.json"), "utf8")));
  } catch {
    return undefined;
  }
}

function spawnDetached(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { detached: true, stdio: "ignore", windowsHide: true, env: cleanLaunchEnv(process.env) });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export class IdeUpdater implements vscode.Disposable {
  readonly info: IdeInfo | undefined;
  private timers: NodeJS.Timeout[] = [];
  private busy = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: AgentLog,
    private readonly locale: () => Locale,
    private readonly deps: IdeUpdaterDeps = {},
  ) {
    this.info = deps.info ?? readIdeInfo();
  }

  get standalone(): boolean {
    return this.info !== undefined;
  }

  /** Marks the context key and, in the standalone IDE, schedules the background checks. */
  start(): void {
    void vscode.commands.executeCommand("setContext", "hermes.standalone", this.standalone);
    if (!this.standalone) return;
    this.timers.push(
      setTimeout(() => void this.checkNow(false), STARTUP_DELAY_MS),
      setInterval(() => void this.checkNow(false), CHECK_INTERVAL_MS),
    );
  }

  private feedUrl(): string {
    const override = vscode.workspace.getConfiguration("hermes.update").get<string>("feedUrl", "").trim();
    return override || this.info?.updateFeedUrl || "";
  }

  /** Background checks respect `hermes.update.check` and a skipped version; a manual check always reports back. */
  async checkNow(userInitiated: boolean): Promise<UpdateInfo | undefined> {
    const loc = this.locale();
    if (!this.info) {
      if (userInitiated) void vscode.window.showInformationMessage(t(loc, "update.standaloneOnly"));
      return undefined;
    }
    if (privacySettings().localOnly) {
      if (userInitiated) void vscode.window.showInformationMessage(t(loc, "privacy.updates.off"));
      return undefined;
    }
    if (!userInitiated && !vscode.workspace.getConfiguration("hermes.update").get<boolean>("check", true)) return undefined;
    if (this.busy) return undefined;
    this.busy = true;
    try {
      let update: UpdateInfo | undefined;
      try {
        update = await checkForUpdate(this.info, this.feedUrl(), { fetchImpl: this.deps.fetchImpl });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log.info(`IDE update check failed: ${message}`);
        if (userInitiated) void vscode.window.showWarningMessage(t(loc, "update.checkFailed", message));
        return undefined;
      }
      if (!update) {
        this.log.info(`IDE is up to date (${this.info.version})`);
        if (userInitiated) void vscode.window.showInformationMessage(t(loc, "update.upToDate", this.info.version));
        return undefined;
      }
      this.log.info(`IDE update available: ${this.info.version} -> ${update.version}`);
      if (!userInitiated && this.context.globalState.get<string>(SKIPPED_KEY) === update.version) return update;
      void this.prompt(update);
      return update;
    } finally {
      this.busy = false;
    }
  }

  private async prompt(update: UpdateInfo): Promise<void> {
    const loc = this.locale();
    const install = t(loc, "update.install");
    const skip = t(loc, "update.skip");
    const answer = await vscode.window.showInformationMessage(
      t(loc, "update.available", update.version, this.info?.version ?? ""),
      install,
      t(loc, "update.later"),
      skip,
    );
    if (answer === install) await this.install(update);
    else if (answer === skip) await this.context.globalState.update(SKIPPED_KEY, update.version);
  }

  /** Downloads and verifies the installer, then hands over to it and closes the IDE. */
  async install(update: UpdateInfo): Promise<boolean> {
    const loc = this.locale();
    if (!(await this.ensureSaved())) return false;

    const dir = this.deps.downloadDir ?? path.join(os.tmpdir(), "hermes-ide-update");
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);

    let file: string;
    try {
      file = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: t(loc, "update.downloading", update.version), cancellable: true },
        async (progress, token) => {
          const abort = new AbortController();
          token.onCancellationRequested(() => abort.abort());
          let last = 0;
          return downloadInstaller(update, dir, {
            fetchImpl: this.deps.fetchImpl,
            signal: abort.signal,
            onProgress: (received, total) => {
              const pct = Math.floor((received / total) * 100);
              if (pct > last) {
                progress.report({ increment: pct - last, message: `${pct}%` });
                last = pct;
              }
            },
          });
        },
      );
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return false;
      const message = err instanceof Error ? err.message : String(err);
      this.log.info(`IDE update download failed: ${message}`);
      void vscode.window.showErrorMessage(t(loc, "update.downloadFailed", message));
      return false;
    }

    try {
      this.log.info(`Launching installer ${file}`);
      await (this.deps.launchInstaller ?? spawnDetached)(file, INSTALLER_ARGS);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.info(`IDE update launch failed: ${message}`);
      void vscode.window.showErrorMessage(t(loc, "update.launchFailed", message));
      return false;
    }
    void vscode.window.showInformationMessage(t(loc, "update.launching"));
    await (this.deps.quit ?? (() => vscode.commands.executeCommand("workbench.action.quit")))();
    return true;
  }

  /** The installer closes the IDE, so unsaved files must be dealt with first. Returns false if the user backs out. */
  private async ensureSaved(): Promise<boolean> {
    const dirty = () => vscode.workspace.textDocuments.filter((d) => d.isDirty && !d.isUntitled);
    const pending = dirty();
    if (!pending.length) return true;
    const loc = this.locale();
    const save = t(loc, "update.saveAndUpdate");
    const answer = await vscode.window.showWarningMessage(t(loc, "update.unsaved", pending.length), { modal: true }, save);
    if (answer !== save) return false;
    await vscode.workspace.saveAll(false);
    return dirty().length === 0;
  }

  dispose(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
  }
}
