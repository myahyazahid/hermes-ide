// Finds the `hermes` executable and checks it against the versions this extension was tested with.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Hermes versions the ACP integration was validated against (PRD: pin supported versions). */
export const SUPPORTED_HERMES = { min: "0.21.0", maxExclusive: "0.22.0" };

export interface LocateOptions {
  configuredPath?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  exists?: (p: string) => boolean;
}

export function locateHermes(opts: LocateOptions = {}): string | undefined {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const exists = opts.exists ?? existsSync;
  const p = platform === "win32" ? path.win32 : path.posix;

  const configured = opts.configuredPath?.trim();
  if (configured) return exists(configured) ? configured : undefined;

  const exts = platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean) : [""];
  const dirs = (env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : ":").filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = p.join(dir, `hermes${ext.toLowerCase()}`);
      if (exists(candidate)) return candidate;
    }
  }

  const home = env.USERPROFILE ?? env.HOME ?? os.homedir();
  const fallbacks =
    platform === "win32"
      ? [p.join(env.LOCALAPPDATA ?? p.join(home, "AppData", "Local"), "hermes", "bin", "hermes.exe")]
      : [p.join(home, ".local", "bin", "hermes"), p.join(home, ".hermes", "bin", "hermes")];
  return fallbacks.find((f) => exists(f));
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

export function isSupportedVersion(version: string): boolean {
  return compareVersions(version, SUPPORTED_HERMES.min) >= 0 && compareVersions(version, SUPPORTED_HERMES.maxExclusive) < 0;
}

/** `hermes acp --version` prints just the version, e.g. "0.21.4". */
export function readHermesVersion(command: string, env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const shell = needsShell(command);
    execFile(shell ? `"${command}"` : command, ["acp", "--version"], { env, timeout: 30_000, windowsHide: true, shell },
      (error, stdout) => {
        if (error) return reject(error);
        const match = /\d+\.\d+\.\d+/.exec(stdout);
        if (!match) return reject(new Error(`Unrecognised version output: ${stdout.trim()}`));
        resolve(match[0]);
      });
  });
}

/** .cmd/.bat shims cannot be spawned directly on Windows. */
export function needsShell(command: string): boolean {
  return /\.(cmd|bat)$/i.test(command);
}
