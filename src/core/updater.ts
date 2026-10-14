// Self-update for the standalone IDE (phase 4): parse the release feed, compare versions, download the installer and
// verify it. No VS Code imports. The feed is produced by ide/scripts/build.mjs and published next to the installers.
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import * as path from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";

export type IdeArch = "x64" | "arm64";

/** The `hermesIde` block that ide/scripts/lib.mjs adds to the standalone IDE's product.json. */
export interface IdeInfo {
  version: string;
  arch: IdeArch;
  updateFeedUrl: string;
}

export interface InstallerAsset {
  url: string;
  sha256: string;
  size: number;
}

export interface UpdateInfo {
  version: string;
  releasedAt: string;
  notes: string;
  installer: InstallerAsset;
}

const MAX_FEED_BYTES = 256 * 1024;
const MAX_INSTALLER_BYTES = 2 * 1024 ** 3;
const FEED_TIMEOUT_MS = 15_000;

/** Arguments for a background update: silent, no restart prompt, and `/UPDATE=1` makes the installer wait for the IDE and relaunch it. */
export const INSTALLER_ARGS = ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/CLOSEAPPLICATIONS", "/UPDATE=1"];

/**
 * Environment for a process that must start a fresh IDE (the installer relaunches it). The extension host runs with
 * ELECTRON_RUN_AS_NODE and VSCODE_* set; inherited, they would turn the relaunched Hermes IDE into a plain Node process.
 */
export function cleanLaunchEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (key === "ELECTRON_RUN_AS_NODE" || key === "ELECTRON_NO_ATTACH_CONSOLE" || key.startsWith("VSCODE_")) continue;
    out[key] = value;
  }
  return out;
}

export function parseIdeInfo(productJson: unknown): IdeInfo | undefined {
  const block = (productJson as { hermesIde?: Record<string, unknown> } | null)?.hermesIde;
  if (!block || typeof block !== "object") return undefined;
  const { version, arch, updateFeedUrl } = block as Record<string, unknown>;
  if (typeof version !== "string" || !parseVersion(version)) return undefined;
  if (arch !== "x64" && arch !== "arm64") return undefined;
  if (typeof updateFeedUrl !== "string") return undefined;
  return { version, arch, updateFeedUrl };
}

interface Semver {
  core: [number, number, number];
  pre: string[];
}

export function parseVersion(text: string): Semver | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text.trim());
  if (!m) return undefined;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : [] };
}

/** Semver precedence: negative when `a` is older than `b`. Throws on a version that is not `x.y.z[-pre]`. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) throw new Error(`Invalid version: ${!pa ? a : b}`);
  for (let i = 0; i < 3; i++) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] < pb.core[i] ? -1 : 1;
  }
  if (!pa.pre.length || !pb.pre.length) return pa.pre.length === pb.pre.length ? 0 : pa.pre.length ? -1 : 1; // 1.0.0 > 1.0.0-beta
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    } else if (xn !== yn) {
      return xn ? -1 : 1; // numeric identifiers sort before alphanumeric ones
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** https only; plain http is accepted for loopback so tests and local mirrors work. */
export function isAllowedUrl(text: string): boolean {
  try {
    const u = new URL(text);
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

export class FeedError extends Error {}

/** Validates a parsed `latest.json` and picks the installer for `platform` (e.g. `win32-x64`). */
export function parseFeed(raw: unknown, platform: string): UpdateInfo {
  const feed = raw as { schema?: unknown; version?: unknown; releasedAt?: unknown; notes?: unknown; installers?: Record<string, unknown> } | null;
  if (!feed || typeof feed !== "object") throw new FeedError("Feed is not an object");
  if (feed.schema !== 1) throw new FeedError(`Unsupported feed schema: ${String(feed.schema)}`);
  if (typeof feed.version !== "string" || !parseVersion(feed.version)) throw new FeedError(`Feed version is invalid: ${String(feed.version)}`);
  const entry = feed.installers?.[platform] as Partial<InstallerAsset> | undefined;
  if (!entry || typeof entry !== "object") throw new FeedError(`Feed has no installer for ${platform}`);
  if (typeof entry.url !== "string" || !isAllowedUrl(entry.url)) throw new FeedError("Installer URL must be https");
  if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) throw new FeedError("Installer sha256 is missing or malformed");
  if (typeof entry.size !== "number" || !Number.isInteger(entry.size) || entry.size <= 0 || entry.size > MAX_INSTALLER_BYTES) {
    throw new FeedError("Installer size is missing or out of range");
  }
  return {
    version: feed.version,
    releasedAt: typeof feed.releasedAt === "string" ? feed.releasedAt : "",
    notes: typeof feed.notes === "string" ? feed.notes : "",
    installer: { url: entry.url, sha256: entry.sha256, size: entry.size },
  };
}

export interface FetchOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/** Returns the newer release described by the feed, or undefined when `current` is already up to date. */
export async function checkForUpdate(
  info: Pick<IdeInfo, "version" | "arch">,
  feedUrl: string,
  { fetchImpl = fetch, signal }: FetchOptions = {},
): Promise<UpdateInfo | undefined> {
  if (!isAllowedUrl(feedUrl)) throw new FeedError("Update feed URL must be https");
  const timeout = AbortSignal.timeout(FEED_TIMEOUT_MS);
  const res = await fetchImpl(feedUrl, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, headers: { accept: "application/json" } });
  if (!res.ok) throw new FeedError(`Feed request failed: HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_FEED_BYTES) throw new FeedError("Feed is too large");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new FeedError("Feed is not valid JSON");
  }
  const update = parseFeed(raw, `win32-${info.arch}`);
  return compareVersions(update.version, info.version) > 0 ? update : undefined;
}

/**
 * Downloads the installer into `dir`, hashing while streaming. The file only appears under its final name once size
 * and SHA-256 match the feed; anything else is deleted. The name is derived from the validated version, never the URL.
 */
export async function downloadInstaller(
  update: UpdateInfo,
  dir: string,
  { fetchImpl = fetch, signal, onProgress }: FetchOptions & { onProgress?: (received: number, total: number) => void } = {},
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, `HermesIDE-Setup-${update.version.replace(/[^0-9A-Za-z.-]/g, "_")}.exe`);
  const part = `${target}.part`;
  const { size, sha256, url } = update.installer;
  const res = await fetchImpl(url, { signal, redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);

  const hash = createHash("sha256");
  let received = 0;
  try {
    await pipeline(
      Readable.fromWeb(res.body as unknown as WebReadableStream),
      async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          received += chunk.length;
          if (received > size) throw new Error("Download is larger than the size in the feed");
          hash.update(chunk);
          onProgress?.(received, size);
          yield chunk;
        }
      },
      createWriteStream(part),
    );
    if (received !== size) throw new Error(`Download is incomplete (${received} of ${size} bytes)`);
    if (hash.digest("hex") !== sha256) throw new Error("Installer checksum does not match the feed");
  } catch (err) {
    await rm(part, { force: true });
    throw err;
  }
  await rm(target, { force: true });
  await rename(part, target);
  return target;
}
