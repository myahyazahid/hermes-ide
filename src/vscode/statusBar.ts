// F-11: ACP connection state on the left, active model on the right.
import * as vscode from "vscode";
import { shortModelName } from "../core/endpoint";
import type { ViewState } from "../shared/protocol";
import { t, type Locale } from "../shared/strings";

export class HermesStatusBar implements vscode.Disposable {
  private readonly connection = vscode.window.createStatusBarItem("hermes.connection", vscode.StatusBarAlignment.Left, 100);
  private readonly model = vscode.window.createStatusBarItem("hermes.model", vscode.StatusBarAlignment.Right, 100);

  constructor(private readonly locale: () => Locale) {
    this.connection.name = "Hermes · ACP";
    this.model.name = "Hermes · model";
    this.connection.command = "hermes.openChat";
    this.model.command = "hermes.switchProfile";
  }

  update(state: ViewState): void {
    const loc = this.locale();
    const icon = {
      ready: state.busy ? "$(loading~spin)" : "$(circle-filled)",
      starting: "$(loading~spin)",
      checking: "$(loading~spin)",
      crashed: "$(error)",
      missing: "$(warning)",
      needsSetup: "$(warning)",
      untrusted: "$(shield)",
      noWorkspace: "$(circle-outline)",
      stopped: "$(circle-outline)",
    }[state.phase];
    this.connection.text = `${icon} Hermes · ACP`;
    const statusKey = state.phase === "ready" && state.busy ? "status.busy" : (`status.${state.phase}` as const);
    this.connection.tooltip = `${t(loc, statusKey)}\n${t(loc, "statusbar.tooltip")}`;
    this.connection.backgroundColor =
      state.phase === "crashed" ? new vscode.ThemeColor("statusBarItem.errorBackground")
        : state.phase === "missing" || state.phase === "needsSetup" ? new vscode.ThemeColor("statusBarItem.warningBackground")
          : undefined;
    this.connection.show();

    const label = state.models.find((m) => m.id === state.currentModelId)?.label ?? shortModelName(state.currentModelId);
    if (state.phase === "ready" && label) {
      this.model.text = label;
      const profile = state.endpoint.profiles.find((p) => p.id === state.endpoint.activeProfileId);
      this.model.tooltip = `${profile?.name ?? ""} · ${state.currentModelId ?? ""}
${t(loc, "statusbar.switchProfile")}`;
      this.model.show();
    } else {
      this.model.hide();
    }
  }

  dispose(): void {
    this.connection.dispose();
    this.model.dispose();
  }
}
