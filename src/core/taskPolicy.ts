// What a background (parallel) task is allowed to do while nobody is watching it. A task runs in its own git worktree,
// so file edits there are free; everything that could reach beyond it is denied unless the user already trusted it:
// terminal commands need the task to be started with commands allowed AND the exact command to be on the workspace
// allowlist (the "always allow" list), and never when the command looks dangerous or, in full local mode, networked.
import * as path from "node:path";
import { dangerousReason, type CommandAllowlist } from "./commandPolicy";
import type { ParsedPermission } from "./permission";
import { analyzeCommand, gitPushRemotes } from "./deploy";
import { networkCommandReason } from "./privacy";

export interface TaskPolicyContext {
  /** Absolute path of the task's worktree. */
  worktree: string;
  allowCommands: boolean;
  allowlist: CommandAllowlist;
  localOnly: boolean;
  allowedHosts: readonly string[];
}

export type DenyReason = "outside" | "commandsOff" | "notAllowlisted" | "dangerous" | "network" | "deploy" | "other";

export type TaskDecision = { allow: true } | { allow: false; reason: DenyReason; subject: string };

/** True when `target` (absolute, or relative to `root`) lies inside `root`. Symbolic links are not followed. */
export function isInside(root: string, target: string): boolean {
  const resolved = path.resolve(root, target);
  const rel = path.relative(path.resolve(root), resolved);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function decideTaskPermission(parsed: ParsedPermission, ctx: TaskPolicyContext): TaskDecision {
  if (parsed.variant === "edit") {
    const outside = parsed.paths.find((p) => !isInside(ctx.worktree, p));
    return outside === undefined ? { allow: true } : { allow: false, reason: "outside", subject: outside };
  }
  if (parsed.variant === "execute") {
    const subject = parsed.command;
    if (!ctx.allowCommands) return { allow: false, reason: "commandsOff", subject };
    if (dangerousReason(subject)) return { allow: false, reason: "dangerous", subject };
    // Nobody watches a task, so it never reaches a server, even with commands allowed and the command on the allowlist.
    if (analyzeCommand(subject).length || gitPushRemotes(subject).length) return { allow: false, reason: "deploy", subject };
    if (ctx.localOnly && networkCommandReason(subject, ctx.allowedHosts)) return { allow: false, reason: "network", subject };
    if (!ctx.allowlist.allows(subject)) return { allow: false, reason: "notAllowlisted", subject };
    return { allow: true };
  }
  return { allow: false, reason: "other", subject: parsed.title };
}
