// Deploy to a VPS from the agent panel (phase 7): the list of servers, a connection check, the prompt that sets the
// agent's ground rules, and the history of the commands to servers the user decided on. The agent does the deploying,
// through its terminal tool and the permission cards; this class only knows about the servers around that.
import { execFile } from "node:child_process";
import * as vscode from "vscode";
import {
  addRecord, analyzeDeploy, checkArgs, classifyConnection, deployPrompt, parseTargets, trimCommand, validateTarget,
  type ConnectionVerdict, type DeployAnalysis, type DeployRecord, type DeployTarget,
} from "../core/deploy";
import { classifyUrl, isAcceptable } from "../core/privacy";
import type { DeployPanel, HostToView, TerminalApprovalState } from "../shared/protocol";
import { t, type Locale, type StringKey } from "../shared/strings";
import type { AgentLog } from "./agentLog";
import { privacySettings } from "./privacyGate";

const HISTORY_KEY = "hermes.deployHistory";

export interface DeployHost {
  locale(): Locale;
  post(msg: HostToView): void;
  terminalApproval(): TerminalApprovalState;
}

export class DeployManager {
  private notice: DeployPanel["notice"];
  private checking: string | undefined;
  private readonly results = new Map<string, { verdict: ConnectionVerdict; text: string }>();
  /** Test hook: runs `ssh` with these arguments. */
  runSsh: (args: string[]) => Promise<{ code: number | null; output: string; spawnFailed: boolean }> = runSsh;
  /** Test hook: answers the delete confirmation without showing it. */
  confirmOverride: ((message: string) => Promise<boolean>) | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: AgentLog,
    private readonly host: DeployHost,
  ) {}

  private tr(key: StringKey, ...args: (string | number)[]): string {
    return t(this.host.locale(), key, ...args);
  }

  // ---- targets ------------------------------------------------------------------------------

  targets(): DeployTarget[] {
    return parseTargets(vscode.workspace.getConfiguration("hermes.deploy").get("targets"));
  }

  private find(name: string): DeployTarget | undefined {
    return this.targets().find((x) => x.name === name);
  }

  private async writeTargets(list: DeployTarget[]): Promise<void> {
    await vscode.workspace.getConfiguration("hermes.deploy").update("targets", list, vscode.ConfigurationTarget.Global);
  }

  view(): DeployPanel {
    const blocked = this.host.terminalApproval() === "active" ? undefined : this.tr("deploy.needApproval");
    return {
      targets: this.targets(),
      ...(blocked ? { blocked } : {}),
      ...(this.checking ? { checking: this.checking } : {}),
      results: Object.fromEntries([...this.results].map(([name, r]) => [name, { ok: r.verdict === "ok", text: r.text }])),
      historyCount: this.history().length,
      ...(this.notice ? { notice: this.notice } : {}),
    };
  }

  publish(notice?: DeployPanel["notice"] | null): void {
    if (notice !== undefined) this.notice = notice ?? undefined;
    this.host.post({ type: "deploy", panel: this.view() });
  }

  /** Adds or replaces a server (by its previous name when it is being renamed). */
  async save(target: DeployTarget, originalName?: string): Promise<void> {
    const problem = validateTarget(target);
    if (problem) return this.publish({ level: "error", text: this.tr(`deploy.problem.${problem}` as StringKey) });
    const list = this.targets();
    const taken = list.some((x) => x.name.toLowerCase() === target.name.toLowerCase() && x.name !== originalName);
    if (taken) return this.publish({ level: "error", text: this.tr("deploy.problem.duplicate") });
    const next = originalName ? list.map((x) => (x.name === originalName ? target : x)) : [...list, target];
    await this.writeTargets(next);
    this.results.delete(originalName ?? target.name);
    this.log.info(`deploy: saved target ${target.name} (${target.user}@${target.host})`);
    this.publish({ level: "ok", text: this.tr("deploy.saved", target.name) });
  }

  async remove(name: string): Promise<void> {
    if (!this.find(name)) return;
    const yes = this.tr("deploy.confirmYes");
    const ok = this.confirmOverride ? await this.confirmOverride(name) : (await vscode.window.showWarningMessage(this.tr("deploy.confirmDelete", name), { modal: true }, yes)) === yes;
    if (!ok) return;
    await this.writeTargets(this.targets().filter((x) => x.name !== name));
    this.results.delete(name);
    this.publish({ level: "ok", text: this.tr("deploy.deleted", name) });
  }

  // ---- connection check ---------------------------------------------------------------------

  /** Logs in once with the key, runs `true`, and says why in plain words when that fails. */
  async test(name: string): Promise<void> {
    const target = this.find(name);
    if (!target || this.checking) return;
    const privacy = privacySettings();
    if (privacy.localOnly && !isAcceptableHost(target.host, privacy.allowedHosts)) {
      return this.publish({ level: "error", text: this.tr("deploy.localBlocked") });
    }
    this.checking = name;
    this.publish(null);
    try {
      const run = await this.runSsh(checkArgs(target));
      const verdict = classifyConnection(run.code, run.output, run.spawnFailed);
      const last = run.output.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
      this.results.set(name, { verdict, text: this.tr(`deploy.verdict.${verdict}` as StringKey, last.slice(0, 200)) });
      this.log.info(`deploy: connection check ${name} -> ${verdict}`);
    } finally {
      this.checking = undefined;
      this.publish();
    }
  }

  /** A terminal with the ssh command typed but not run: the user presses Enter and checks the fingerprint with their own eyes. */
  openTerminal(name: string): void {
    const target = this.find(name);
    if (!target) return;
    const terminal = vscode.window.createTerminal({ name: "Hermes SSH" });
    terminal.show();
    terminal.sendText(`ssh${target.port ? ` -p ${target.port}` : ""}${target.identityFile ? ` -i "${target.identityFile}"` : ""} ${target.user}@${target.host}`, false);
  }

  /** The prompt for this server, to be put in the message box (never sent by itself). */
  prompt(name: string): string | undefined {
    const target = this.find(name);
    return target ? deployPrompt(target, this.host.locale()) : undefined;
  }

  // ---- reading commands ---------------------------------------------------------------------

  analyze(command: string): DeployAnalysis | null {
    return analyzeDeploy(command, this.targets());
  }

  /** The words for a permission card: where the command goes and what is risky there. */
  describe(analysis: DeployAnalysis): string {
    const parts: string[] = [];
    if (analysis.targets.length) {
      parts.push(this.tr("deploy.card.target", analysis.targets.map((x) => x.name).join(", "), analysis.targets.map((x) => `${x.user}@${x.host}`).join(", ")));
    }
    const hosts = analysis.unknownHosts.filter((h) => h !== "?");
    if (hosts.length) parts.push(this.tr("deploy.card.unknown", hosts.join(", ")));
    else if (analysis.unknownHosts.includes("?") && !analysis.targets.length) parts.push(this.tr("deploy.card.unclear"));
    if (analysis.risks.length) parts.push(this.tr("deploy.card.risks", analysis.risks.map((r) => this.tr(`deploy.risk.${r.code}` as StringKey)).join("; ")));
    return parts.join(" ");
  }

  // ---- history ------------------------------------------------------------------------------

  history(): DeployRecord[] {
    return this.context.globalState.get<DeployRecord[]>(HISTORY_KEY) ?? [];
  }

  /** Remembers a decision on a command to a server. */
  async record(command: string, analysis: DeployAnalysis, outcome: DeployRecord["outcome"]): Promise<void> {
    const registered = analysis.targets.length > 0;
    const target = registered ? analysis.targets.map((x) => x.name).join(", ") : analysis.unknownHosts.filter((h) => h !== "?").join(", ") || "?";
    await this.context.globalState.update(HISTORY_KEY, addRecord(this.history(), {
      at: Date.now(), target, registered, command: trimCommand(command), outcome, risks: analysis.risks.map((r) => r.code),
    }));
    if (this.notice === undefined) this.publish();
  }

  async showHistory(): Promise<void> {
    const records = this.history();
    const loc = this.host.locale();
    const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
    const lines = [`# ${t(loc, "deploy.history.title")}`, "", t(loc, "deploy.history.hint"), ""];
    if (!records.length) lines.push(t(loc, "deploy.history.empty"));
    else {
      lines.push(`| ${["time", "server", "decision", "command", "attention"].map((k) => t(loc, `deploy.history.${k}` as StringKey)).join(" | ")} |`);
      lines.push("| --- | --- | --- | --- | --- |");
      for (const r of records.slice().reverse()) {
        const risks = r.risks.map((c) => t(loc, `deploy.risk.${c}` as StringKey)).join("; ");
        const server = r.registered ? r.target : `${r.target} (${t(loc, "deploy.history.unregistered")})`;
        lines.push(`| ${new Date(r.at).toLocaleString(loc === "id" ? "id-ID" : "en-GB")} | ${cell(server)} | ${t(loc, `deploy.outcome.${r.outcome}` as StringKey)} | \`${cell(r.command).replace(/`/g, "'")}\` | ${cell(risks)} |`);
      }
    }
    const doc = await vscode.workspace.openTextDocument({ language: "markdown", content: `${lines.join("\n")}\n` });
    await vscode.window.showTextDocument(doc, { preview: false });
  }
}

function isAcceptableHost(host: string, allowed: string[]): boolean {
  return isAcceptable(classifyUrl(`https://${host.includes(":") ? `[${host}]` : host}`, allowed).kind);
}

function runSsh(args: string[]): Promise<{ code: number | null; output: string; spawnFailed: boolean }> {
  return new Promise((resolve) => {
    const child = execFile("ssh", args, { timeout: 30_000, windowsHide: true }, (error, stdout, stderr) => {
      const missing = (error as { code?: unknown } | null)?.code === "ENOENT";
      const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : missing ? null : 255) : 0;
      resolve({ code, output: `${stdout}${stderr}`, spawnFailed: missing });
    });
    child.stdin?.end();
  });
}
