// Tells the user when the agent finished or needs a permission while they are elsewhere (phase 5).
// Two channels: a message inside the IDE, and on Windows a native toast so it is seen even when the window is hidden.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { encodePowerShell, parseNotifyMode, shouldNotify, toastScript, type NotifyKind } from "../core/notify";
import { t, type Locale } from "../shared/strings";
import type { AgentLog } from "./agentLog";

const DEFAULT_MIN_SECONDS = 10;

export interface NotifierDeps {
  locale(): Locale;
  /** Brings the chat panel to the front (the "Open panel" button and the click target). */
  openPanel(): void;
  /** Test hooks. */
  windowFocused?: () => boolean;
  showToast?: (title: string, body: string) => void;
}

/** The app's AppUserModelID, which Windows needs to attribute a toast to a registered app. */
function appUserModelId(): string | undefined {
  try {
    const product = JSON.parse(readFileSync(path.join(vscode.env.appRoot, "product.json"), "utf8")) as { win32AppUserModelId?: string };
    return typeof product.win32AppUserModelId === "string" ? product.win32AppUserModelId : undefined;
  } catch {
    return undefined;
  }
}

export class Notifier {
  constructor(private readonly log: AgentLog, private readonly deps: NotifierDeps) {}

  /** Shows a notification if the settings and the situation call for one. Returns whether it did. */
  notify(kind: NotifyKind, detail: string, turnMs?: number): boolean {
    const cfg = vscode.workspace.getConfiguration("hermes.notifications");
    const focused = this.deps.windowFocused ? this.deps.windowFocused() : vscode.window.state.focused;
    const ok = shouldNotify({
      mode: parseNotifyMode(cfg.get("mode")),
      kind,
      windowFocused: focused,
      turnMs,
      minSeconds: cfg.get<number>("minSeconds", DEFAULT_MIN_SECONDS),
    });
    if (!ok) return false;

    const loc = this.deps.locale();
    const title = t(loc, kind === "done" ? "notify.done" : "notify.permission");
    const open = t(loc, "notify.open");
    void vscode.window.showInformationMessage(detail ? `${title}: ${detail}` : title, open).then((choice) => {
      if (choice === open) this.deps.openPanel();
    });
    if (cfg.get<boolean>("native", true)) (this.deps.showToast ?? ((a, b) => this.toast(a, b)))(title, detail);
    return true;
  }

  private toast(title: string, body: string): void {
    if (process.platform !== "win32") return;
    const aumid = appUserModelId();
    if (!aumid) return;
    try {
      const child = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePowerShell(toastScript(aumid, title, body))],
        { windowsHide: true, stdio: "ignore", detached: true },
      );
      child.once("error", (e) => this.log.info(`toast failed: ${e.message}`));
      child.unref();
    } catch (error) {
      this.log.info(`toast failed: ${(error as Error).message}`);
    }
  }
}
