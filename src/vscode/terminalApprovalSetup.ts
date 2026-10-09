// Installs the IDE's pre_tool_call hook (see core/terminalApproval.ts) so every terminal command
// asks first. In an IDE-owned profile the hook is written automatically; in the user's own Hermes
// config it is only added after the user agrees in the panel, with a backup of the original file.
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { defaultHermesHome } from "../core/endpoint";
import {
  HOOK_ENV, HOOK_SCRIPT, HOOK_SCRIPT_NAME, hasApprovalHook, hookCommand, withAllowlistEntry, withApprovalHook,
  withoutApprovalHook,
} from "../core/terminalApproval";
import type { TerminalApprovalState } from "../shared/protocol";
import type { AgentLog } from "./agentLog";

const DISMISSED_KEY = "hermes.terminalApproval.dismissed";
const ALLOWLIST_FILE = "shell-hooks-allowlist.json";

export class TerminalApprovalSetup {
  private nodePath: string | undefined | null = null; // null = not resolved yet

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: AgentLog,
  ) {}

  private get enabledBySetting(): boolean {
    return vscode.workspace.getConfiguration("hermes").get<boolean>("terminal.askEveryCommand", true);
  }

  /** Env Hermes needs so the hook knows it runs under the IDE. */
  env(state: TerminalApprovalState): Record<string, string> {
    return state === "active" ? { [HOOK_ENV]: "1" } : {};
  }

  /** Prepares an IDE-owned HERMES_HOME: hook in config.yaml and its allowlist entry. */
  async prepareProfile(profileHome: string, baseYaml: string): Promise<{ yaml: string; state: TerminalApprovalState }> {
    if (!this.enabledBySetting) return { yaml: baseYaml, state: "disabled" };
    const command = await this.command();
    if (!command) return { yaml: baseYaml, state: "unavailable" };
    await this.ensureAllowlisted(profileHome, command);
    return { yaml: withApprovalHook(baseYaml, command), state: "active" };
  }

  /** State for the user's own Hermes config (profile "hermes"); never writes anything. */
  async hermesConfigState(): Promise<TerminalApprovalState> {
    if (!this.enabledBySetting) return "disabled";
    const command = await this.command();
    if (!command) return "unavailable";
    const yaml = await readFile(this.hermesConfigPath(), "utf8").catch(() => "");
    if (hasApprovalHook(yaml)) {
      // Our entry may point at an older script/node path after an update; refresh our own entry.
      const updated = withApprovalHook(yaml, command);
      if (updated !== yaml) {
        await writeFile(this.hermesConfigPath(), updated, "utf8");
        await this.ensureAllowlisted(defaultHermesHome(), command);
        this.log.info("terminal approval hook path refreshed in Hermes config");
      }
      return "active";
    }
    return this.context.globalState.get<boolean>(DISMISSED_KEY) ? "dismissed" : "needsConsent";
  }

  /** Called when the user agrees in the panel. */
  async enableInHermesConfig(): Promise<void> {
    const command = await this.command();
    if (!command) throw new Error("Node.js runtime not found for the approval hook");
    const configPath = this.hermesConfigPath();
    const yaml = await readFile(configPath, "utf8").catch(() => "");
    const backup = `${configPath}.hermes-ide-backup`;
    if (yaml && !existsSync(backup)) await copyFile(configPath, backup);
    await writeFile(configPath, withApprovalHook(yaml, command), "utf8");
    await this.ensureAllowlisted(defaultHermesHome(), command);
    await this.context.globalState.update(DISMISSED_KEY, false);
    this.log.info(`terminal approval hook added to ${configPath} (backup: ${backup})`);
  }

  async dismiss(): Promise<void> {
    await this.context.globalState.update(DISMISSED_KEY, true);
  }

  async removeFromHermesConfig(): Promise<boolean> {
    const configPath = this.hermesConfigPath();
    const yaml = await readFile(configPath, "utf8").catch(() => "");
    const updated = withoutApprovalHook(yaml);
    if (updated === yaml) return false;
    await writeFile(configPath, updated, "utf8");
    this.log.info(`terminal approval hook removed from ${configPath}`);
    return true;
  }

  private hermesConfigPath(): string {
    return path.join(defaultHermesHome(), "config.yaml");
  }

  private async ensureAllowlisted(home: string, command: string): Promise<void> {
    const file = path.join(home, ALLOWLIST_FILE);
    const current = await readFile(file, "utf8").catch(() => "");
    try {
      const parsed = JSON.parse(current || "{}");
      if (parsed?.approvals?.some?.((e: { event?: string; command?: string }) => e?.event === "pre_tool_call" && e?.command === command)) return;
    } catch {
      // rewrite below
    }
    await mkdir(home, { recursive: true });
    await writeFile(file, withAllowlistEntry(current, command), "utf8");
  }

  private async command(): Promise<string | undefined> {
    const node = this.resolveNode();
    if (!node) return undefined;
    const dir = this.context.globalStorageUri.fsPath;
    const script = path.join(dir, HOOK_SCRIPT_NAME);
    await mkdir(dir, { recursive: true });
    if ((await readFile(script, "utf8").catch(() => "")) !== HOOK_SCRIPT) await writeFile(script, HOOK_SCRIPT, "utf8");
    return hookCommand(node, script);
  }

  /** `hermes.nodePath`, then Node on PATH, then the Node that the Hermes installer bundles. */
  private resolveNode(): string | undefined {
    if (this.nodePath !== null) return this.nodePath;
    const configured = vscode.workspace.getConfiguration("hermes").get<string>("nodePath")?.trim();
    const win = process.platform === "win32";
    const exe = win ? "node.exe" : "node";
    const candidates = [
      ...(configured ? [configured] : []),
      ...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((d) => path.join(d, exe)),
      path.join(defaultHermesHome(), "node", exe),
      path.join(defaultHermesHome(), "node", "bin", exe),
    ];
    this.nodePath = candidates.find((c) => existsSync(c));
    this.log.info(`approval hook node runtime: ${this.nodePath ?? "<none>"}`);
    return this.nodePath;
  }
}
