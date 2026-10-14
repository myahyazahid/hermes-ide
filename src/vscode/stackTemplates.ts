// Project templates in the workspace (phase 7): notices which of the supported stacks the project is, and writes the
// chosen stack's rules pack to `.hermes/rules/<stack>.md`. A pack is never overwritten: once written it is the project's.
import { mkdir, stat, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { detectStacks, stackRules, stackRulesPath, type ProjectProbe } from "../core/stackRules";
import type { StackView } from "../shared/protocol";
import { STACKS, type StackId } from "../shared/stacks";
import type { Locale } from "../shared/strings";

const DISMISSED_KEY = "hermes.dismissedStacks";
const MAX_MANIFEST_BYTES = 512_000;

function probeFor(root: string): ProjectProbe {
  return {
    has: (rel) => existsSync(path.join(root, ...rel.split("/"))),
    read: (rel) => {
      try {
        const file = path.join(root, ...rel.split("/"));
        return statSync(file).size <= MAX_MANIFEST_BYTES ? readFileSync(file, "utf8") : undefined;
      } catch {
        return undefined;
      }
    },
  };
}

export class StackTemplates {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly root: () => string | undefined,
  ) {}

  /** One row per supported stack: is the project one, is its pack already there, and did the user say "later". */
  views(): StackView[] {
    const root = this.root();
    const detected = new Set(root ? detectStacks(probeFor(root)) : []);
    const dismissed = new Set(this.context.workspaceState.get<string[]>(DISMISSED_KEY) ?? []);
    return STACKS.map((s) => ({
      id: s.id,
      label: s.label,
      detected: detected.has(s.id),
      added: !!root && existsSync(path.join(root, ...stackRulesPath(s.id).split("/"))),
      dismissed: dismissed.has(s.id),
    }));
  }

  async dismiss(id: StackId): Promise<void> {
    const list = new Set(this.context.workspaceState.get<string[]>(DISMISSED_KEY) ?? []);
    list.add(id);
    await this.context.workspaceState.update(DISMISSED_KEY, [...list]);
  }

  /** Writes the pack (never over an existing file) and opens it for the user to read and edit. */
  async add(id: StackId, locale: Locale): Promise<{ path: string; created: boolean } | undefined> {
    const root = this.root();
    if (!root) return undefined;
    const rel = stackRulesPath(id);
    const file = path.join(root, ...rel.split("/"));
    await mkdir(path.dirname(file), { recursive: true });
    const existed = await stat(file).then(() => true, () => false);
    if (!existed) await writeFile(file, stackRules(id, locale), { encoding: "utf8", flag: "wx" });
    await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
    return { path: rel, created: !existed };
  }
}
