// Installing and updating Hermes Agent from the IDE (phase 5), with the "tested version" guard.
//
// What the Hermes CLI allows shapes this: `hermes update` always follows the `main` branch and cannot be pinned to a
// release, so the IDE never updates Hermes silently. It checks (read-only), explains when the result may be newer than
// what this IDE was tested with, takes a full backup first, and verifies the version afterwards. A fresh install, on the
// other hand, can be pinned (the official installer takes -Commit), so onboarding installs the exact tested build.
import { spawn } from "node:child_process";
import { HERMES_INSTALL } from "../shared/hermesVersions";
import { compareVersions, needsShell, SUPPORTED_HERMES, TESTED_HERMES } from "./hermesLocator";

export const HERMES_INSTALL_URL = HERMES_INSTALL.scriptUrl;
const UPDATE_TIMEOUT_MS = 20 * 60_000;
const CHECK_TIMEOUT_MS = 90_000;
const OUTPUT_KEEP = 64_000;

export type VersionStatus = "tested" | "newer" | "older";

/** Where `version` sits relative to the range this IDE was tested with. */
export function versionStatus(version: string): VersionStatus {
  if (compareVersions(version, SUPPORTED_HERMES.min) < 0) return "older";
  return compareVersions(version, SUPPORTED_HERMES.maxExclusive) >= 0 ? "newer" : "tested";
}

function isAllowedInstallUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || (u.protocol === "http:" && ["127.0.0.1", "localhost"].includes(u.hostname));
  } catch {
    return false;
  }
}

/**
 * The PowerShell command that installs Hermes at a pinned commit (default: the tested build). The installer script is
 * run from a script block because `iex` cannot pass parameters. It runs in a visible terminal so the user sees
 * everything it does, including its own provider setup wizard at the end.
 */
export function installCommand(opts: { url?: string; commit?: string } = {}): string {
  const url = opts.url ?? HERMES_INSTALL_URL;
  const commit = opts.commit ?? TESTED_HERMES.commit;
  // Both values end up inside single quotes in a PowerShell command, so they are validated, not escaped.
  if (!isAllowedInstallUrl(url) || /['"`$\s]/.test(url)) throw new Error(`Unsafe install script URL: ${url}`);
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) throw new Error(`Not a git commit id: ${commit}`);
  return HERMES_INSTALL.commandTemplate.replace("{url}", () => url).replace("{commit}", () => commit);
}

export interface UpdateCheck {
  state: "available" | "current" | "unknown";
  /** Commits behind origin/main, when Hermes says so. */
  behind?: number;
  /** Hermes' own words, for the log. */
  raw: string;
}

/** Reads `hermes update --check`. Anything it does not recognise is "unknown", never "current". */
export function parseUpdateCheck(output: string): UpdateCheck {
  const raw = output.trim();
  if (/update available/i.test(raw)) {
    const behind = /(\d+)\s+commits?\s+behind/i.exec(raw);
    return { state: "available", behind: behind ? Number(behind[1]) : undefined, raw };
  }
  if (/(already up[- ]to[- ]date|up[- ]to[- ]date|no updates? available)/i.test(raw)) return { state: "current", raw };
  return { state: "unknown", raw };
}

export interface RunResult {
  code: number | null;
  /** The tail of stdout and stderr combined. */
  output: string;
  timedOut: boolean;
}

/** Runs the Hermes CLI, collecting output. Never rejects: failures come back as a null exit code. */
export function runHermes(
  command: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number; onOutput?: (chunk: string) => void } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    // .cmd shims need a shell; the arguments here are fixed constants, so a single command string is safe.
    const child = needsShell(command)
      ? spawn(`"${command}" ${args.join(" ")}`, { env: opts.env, windowsHide: true, shell: true })
      : spawn(command, args, { env: opts.env, windowsHide: true });
    let output = "";
    let timedOut = false;
    const take = (data: Buffer) => {
      const text = data.toString("utf8");
      output = (output + text).slice(-OUTPUT_KEEP);
      opts.onOutput?.(text);
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32" && child.pid) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      else child.kill("SIGKILL");
    }, opts.timeoutMs ?? CHECK_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, output: `${output}${error.message}`, timedOut });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output, timedOut });
    });
  });
}

/** Read-only: asks Hermes whether an update exists, without installing anything. */
export async function checkHermesUpdate(command: string, env?: NodeJS.ProcessEnv): Promise<UpdateCheck> {
  const run = await runHermes(command, ["update", "--check"], { env, timeoutMs: CHECK_TIMEOUT_MS });
  if (run.code !== 0) return { state: "unknown", raw: run.output.trim() || (run.timedOut ? "timed out" : "failed") };
  return parseUpdateCheck(run.output);
}

/**
 * Runs the update: full backup first (so a bad update can be rolled back with `hermes import`), no interactive prompts.
 * The caller must stop its own `hermes acp` first: on Windows a running Hermes keeps files in its venv locked.
 */
export async function updateHermes(command: string, env: NodeJS.ProcessEnv | undefined, onOutput?: (chunk: string) => void): Promise<RunResult> {
  return runHermes(command, ["update", "--backup", "--yes"], { env, timeoutMs: UPDATE_TIMEOUT_MS, onOutput });
}
