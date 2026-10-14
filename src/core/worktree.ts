// Git plumbing for parallel agent tasks (phase 6). Each task gets its own worktree and branch off the current commit,
// so several agents can edit the same project at once without touching each other or the user's working tree. The
// result comes back as a patch the user reviews and applies, or the task is discarded with its branch.
import { execFile, spawn } from "node:child_process";
import * as path from "node:path";

export interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs git without ever prompting. Never rejects: a failure to run comes back as a null code. */
export function git(cwd: string, args: string[], input?: string, timeoutMs = 60_000): Promise<GitResult> {
  return new Promise((resolve) => {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
    if (input === undefined) {
      execFile("git", args, { cwd, env, windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs }, (error, stdout, stderr) => {
        const code = error ? (typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : null) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) || (code === null && error ? error.message : "") });
      });
      return;
    }
    const child = spawn("git", args, { cwd, env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.once("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: e.message });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input, "utf8");
  });
}

export async function repoRoot(cwd: string): Promise<string | undefined> {
  const r = await git(cwd, ["rev-parse", "--show-toplevel"]);
  return r.code === 0 && r.stdout.trim() ? path.normalize(r.stdout.trim()) : undefined;
}

export async function headCommit(cwd: string): Promise<string | undefined> {
  const r = await git(cwd, ["rev-parse", "--verify", "HEAD"]);
  return r.code === 0 ? r.stdout.trim() : undefined;
}

/** A short, safe id for a task's branch and folder. */
export function newTaskId(now = Date.now(), random = Math.random()): string {
  return now.toString(36).slice(-5) + Math.floor(random * 36 ** 3).toString(36).padStart(3, "0");
}

export const branchFor = (id: string) => `hermes/task-${id}`;

/** Creates the worktree and its branch at `base`. */
export async function createWorktree(root: string, dir: string, branch: string, base: string): Promise<{ ok: boolean; error?: string }> {
  const r = await git(root, ["worktree", "add", "-b", branch, dir, base]);
  return r.code === 0 ? { ok: true } : { ok: false, error: (r.stderr || r.stdout).trim().split(/\r?\n/).slice(-2).join(" ") };
}

export interface ChangeSummary {
  files: string[];
  additions: number;
  deletions: number;
}

/** Commits whatever the task changed on its branch (so nothing is lost) and summarises it against `base`. */
export async function commitTask(dir: string, base: string, message: string): Promise<ChangeSummary> {
  await git(dir, ["add", "-A"]);
  const pending = await git(dir, ["status", "--porcelain"]);
  if (pending.stdout.trim()) {
    // The user's own identity when git has one; otherwise a stand-in so the commit cannot fail on a fresh machine.
    const hasIdentity = (await git(dir, ["config", "user.email"])).stdout.trim() !== "";
    const identity = hasIdentity ? [] : ["-c", "user.name=Hermes IDE", "-c", "user.email=hermes-ide@localhost"];
    await git(dir, [...identity, "commit", "-m", message, "--no-verify", "--no-gpg-sign"]);
  }
  return summarize(dir, base);
}

export async function summarize(dir: string, base: string): Promise<ChangeSummary> {
  const [names, stat] = await Promise.all([git(dir, ["diff", "--name-only", base, "HEAD"]), git(dir, ["diff", "--numstat", base, "HEAD"])]);
  let additions = 0;
  let deletions = 0;
  for (const line of stat.stdout.split(/\r?\n/)) {
    const m = /^(\d+|-)\t(\d+|-)\t/.exec(line);
    if (m) {
      additions += m[1] === "-" ? 0 : Number(m[1]);
      deletions += m[2] === "-" ? 0 : Number(m[2]);
    }
  }
  return { files: names.stdout.split(/\r?\n/).map((f) => f.trim()).filter(Boolean), additions, deletions };
}

/** The task's whole change as a patch (binary-safe), for review and for applying. */
export async function taskPatch(dir: string, base: string): Promise<string> {
  return (await git(dir, ["diff", "--binary", base, "HEAD"])).stdout;
}

/** Applies a patch to the user's working tree as uncommitted changes. Checks first, so it is all or nothing. */
export async function applyPatch(root: string, patch: string): Promise<{ ok: boolean; error?: string }> {
  const check = await git(root, ["apply", "--check", "--whitespace=nowarn", "-"], patch);
  if (check.code !== 0) return { ok: false, error: (check.stderr || check.stdout).trim().split(/\r?\n/).slice(0, 3).join(" ") };
  const applied = await git(root, ["apply", "--whitespace=nowarn", "-"], patch);
  return applied.code === 0 ? { ok: true } : { ok: false, error: applied.stderr.trim().split(/\r?\n/).slice(0, 3).join(" ") };
}

/** Removes the worktree and its branch. Safe to call when either is already gone. */
export async function removeTask(root: string, dir: string, branch: string): Promise<void> {
  await git(root, ["worktree", "remove", "--force", dir]);
  await git(root, ["worktree", "prune"]);
  await git(root, ["branch", "-D", branch]);
}
