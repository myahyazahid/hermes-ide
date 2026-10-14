import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkForUpdate, cleanLaunchEnv, compareVersions, downloadInstaller, FeedError, isAllowedUrl, parseFeed, parseIdeInfo, parseVersion, type UpdateInfo } from "../../src/core/updater";

const sha = (buf: Buffer | string) => createHash("sha256").update(buf).digest("hex");

const feed = (over: Record<string, unknown> = {}) => ({
  schema: 1,
  version: "0.5.0",
  releasedAt: "2026-10-10T00:00:00.000Z",
  notes: "n",
  installers: { "win32-x64": { url: "https://example.com/HermesIDE-Setup-x64-0.5.0.exe", sha256: "a".repeat(64), size: 1234 } },
  ...over,
});

describe("compareVersions", () => {
  it("orders numerically, not lexically", () => {
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("0.4.0", "0.4.1")).toBeLessThan(0);
    expect(compareVersions("v2.0.0", "1.99.99")).toBeGreaterThan(0);
  });

  it("ranks a release above its prereleases and orders prerelease identifiers", () => {
    expect(compareVersions("1.0.0", "1.0.0-beta.2")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-beta.2", "1.0.0-beta.10")).toBeLessThan(0);
    expect(compareVersions("1.0.0-alpha", "1.0.0-beta")).toBeLessThan(0);
    expect(compareVersions("1.0.0-1", "1.0.0-alpha")).toBeLessThan(0);
    expect(compareVersions("1.0.0-beta", "1.0.0-beta.1")).toBeLessThan(0);
    expect(compareVersions("1.0.0+build5", "1.0.0")).toBe(0);
  });

  it("rejects things that are not versions", () => {
    expect(parseVersion("1.2")).toBeUndefined();
    expect(parseVersion("latest")).toBeUndefined();
    expect(() => compareVersions("1.2", "1.0.0")).toThrow(/Invalid version/);
  });
});

describe("parseIdeInfo", () => {
  it("reads the hermesIde block of product.json", () => {
    expect(parseIdeInfo({ hermesIde: { version: "0.4.0", arch: "x64", installer: "user", updateFeedUrl: "https://x/latest.json" } })).toEqual({
      version: "0.4.0",
      arch: "x64",
      updateFeedUrl: "https://x/latest.json",
    });
  });

  it("is undefined outside the standalone IDE or when the block is malformed", () => {
    expect(parseIdeInfo({ nameLong: "Code" })).toBeUndefined();
    expect(parseIdeInfo(null)).toBeUndefined();
    expect(parseIdeInfo({ hermesIde: { version: "x", arch: "x64", updateFeedUrl: "u" } })).toBeUndefined();
    expect(parseIdeInfo({ hermesIde: { version: "0.4.0", arch: "ia32", updateFeedUrl: "u" } })).toBeUndefined();
  });
});

describe("cleanLaunchEnv", () => {
  it("drops the variables that would make a relaunched IDE run as plain Node", () => {
    const env = cleanLaunchEnv({
      ELECTRON_RUN_AS_NODE: "1",
      ELECTRON_NO_ATTACH_CONSOLE: "1",
      VSCODE_PID: "42",
      VSCODE_IPC_HOOK: "pipe-name",
      PATH: "/usr/bin",
      LOCALAPPDATA: "/home/me/.local",
    });
    expect(Object.keys(env).sort()).toEqual(["LOCALAPPDATA", "PATH"]);
  });
});

describe("isAllowedUrl", () => {
  it("accepts https and loopback http only", () => {
    expect(isAllowedUrl("https://github.com/x")).toBe(true);
    expect(isAllowedUrl("http://127.0.0.1:8080/latest.json")).toBe(true);
    expect(isAllowedUrl("http://localhost/x")).toBe(true);
    expect(isAllowedUrl("http://example.com/x")).toBe(false);
    expect(isAllowedUrl("file:///C:/x.exe")).toBe(false);
    expect(isAllowedUrl("not a url")).toBe(false);
  });
});

describe("parseFeed", () => {
  it("picks the installer for the platform", () => {
    expect(parseFeed(feed(), "win32-x64")).toEqual<UpdateInfo>({
      version: "0.5.0",
      releasedAt: "2026-10-10T00:00:00.000Z",
      notes: "n",
      installer: { url: "https://example.com/HermesIDE-Setup-x64-0.5.0.exe", sha256: "a".repeat(64), size: 1234 },
    });
  });

  it.each([
    ["wrong schema", feed({ schema: 2 }), /schema/],
    ["bad version", feed({ version: "next" }), /version/],
    ["no installer for the platform", feed({ installers: {} }), /no installer/],
    ["http installer url", feed({ installers: { "win32-x64": { url: "http://evil.test/a.exe", sha256: "a".repeat(64), size: 1 } } }), /https/],
    ["uppercase/short sha256", feed({ installers: { "win32-x64": { url: "https://x/a.exe", sha256: "ABC", size: 1 } } }), /sha256/],
    ["zero size", feed({ installers: { "win32-x64": { url: "https://x/a.exe", sha256: "a".repeat(64), size: 0 } } }), /size/],
    ["not an object", "nope", /object/],
  ])("rejects %s", (_name, raw, message) => {
    expect(() => parseFeed(raw, "win32-x64")).toThrow(FeedError);
    expect(() => parseFeed(raw, "win32-x64")).toThrow(message);
  });
});

describe("checkForUpdate", () => {
  const respond = (body: string, status = 200) => (async () => new Response(body, { status })) as unknown as typeof fetch;
  const me = { version: "0.4.0", arch: "x64" as const };

  it("returns the release when the feed is newer", async () => {
    const update = await checkForUpdate(me, "https://example.com/latest.json", { fetchImpl: respond(JSON.stringify(feed())) });
    expect(update?.version).toBe("0.5.0");
  });

  it("returns undefined when already current or ahead of the feed", async () => {
    expect(await checkForUpdate(me, "https://example.com/latest.json", { fetchImpl: respond(JSON.stringify(feed({ version: "0.4.0" }))) })).toBeUndefined();
    expect(await checkForUpdate({ ...me, version: "0.9.0" }, "https://example.com/latest.json", { fetchImpl: respond(JSON.stringify(feed())) })).toBeUndefined();
  });

  it("fails loudly on HTTP errors, bad JSON, and non-https feeds", async () => {
    await expect(checkForUpdate(me, "https://example.com/latest.json", { fetchImpl: respond("", 404) })).rejects.toThrow(/HTTP 404/);
    await expect(checkForUpdate(me, "https://example.com/latest.json", { fetchImpl: respond("<html>") })).rejects.toThrow(/JSON/);
    await expect(checkForUpdate(me, "http://example.com/latest.json", { fetchImpl: respond("{}") })).rejects.toThrow(/https/);
  });

  it("asks for the installer matching the running architecture", async () => {
    const both = feed({
      installers: {
        "win32-x64": { url: "https://x/x64.exe", sha256: "a".repeat(64), size: 1 },
        "win32-arm64": { url: "https://x/arm64.exe", sha256: "b".repeat(64), size: 2 },
      },
    });
    const update = await checkForUpdate({ version: "0.4.0", arch: "arm64" }, "https://example.com/latest.json", { fetchImpl: respond(JSON.stringify(both)) });
    expect(update?.installer.url).toBe("https://x/arm64.exe");
  });
});

describe("downloadInstaller", () => {
  const payload = Buffer.from("MZ fake installer ".repeat(5000));
  let server: Server;
  let base: string;
  let dir: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/ok.exe") res.end(payload);
      else if (req.url === "/redirect.exe") {
        res.writeHead(302, { location: "/ok.exe" });
        res.end();
      } else if (req.url === "/gone.exe") {
        res.writeHead(404);
        res.end();
      } else if (req.url === "/short.exe") res.end(payload.subarray(0, 100));
      else res.end(Buffer.concat([payload, Buffer.from("extra")]));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    dir = mkdtempSync(path.join(tmpdir(), "hermes-updater-test-"));
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  });

  const update = (file: string, over: Partial<UpdateInfo["installer"]> = {}): UpdateInfo => ({
    version: "0.5.0",
    releasedAt: "",
    notes: "",
    installer: { url: `${base}/${file}`, sha256: sha(payload), size: payload.length, ...over },
  });

  it("writes the installer only after size and checksum match, reporting progress", async () => {
    const progress: number[] = [];
    const file = await downloadInstaller(update("ok.exe"), dir, { onProgress: (received) => progress.push(received) });
    expect(path.basename(file)).toBe("HermesIDE-Setup-0.5.0.exe");
    expect(readFileSync(file).equals(payload)).toBe(true);
    expect(progress.at(-1)).toBe(payload.length);
    expect(existsSync(`${file}.part`)).toBe(false);
  });

  it("follows redirects (GitHub release assets redirect to a CDN)", async () => {
    const file = await downloadInstaller(update("redirect.exe"), dir);
    expect(readFileSync(file).equals(payload)).toBe(true);
  });

  it("deletes the download when the checksum is wrong", async () => {
    const bad = mkdtempSync(path.join(tmpdir(), "hermes-updater-bad-"));
    await expect(downloadInstaller(update("ok.exe", { sha256: "0".repeat(64) }), bad)).rejects.toThrow(/checksum/);
    expect(readdirSync(bad)).toEqual([]);
    rmSync(bad, { recursive: true, force: true });
  });

  it("rejects a truncated or oversized body and HTTP errors, leaving nothing behind", async () => {
    const bad = mkdtempSync(path.join(tmpdir(), "hermes-updater-bad-"));
    await expect(downloadInstaller(update("short.exe"), bad)).rejects.toThrow(/incomplete/);
    await expect(downloadInstaller(update("long.exe"), bad)).rejects.toThrow(/larger/);
    await expect(downloadInstaller(update("gone.exe"), bad)).rejects.toThrow(/HTTP 404/);
    expect(readdirSync(bad)).toEqual([]);
    rmSync(bad, { recursive: true, force: true });
  });

  it("never lets the feed pick the file name", async () => {
    const file = await downloadInstaller({ ...update("ok.exe"), version: "0.5.0-..\\..\\evil" }, dir);
    expect(path.dirname(file)).toBe(dir);
    expect(path.basename(file)).not.toMatch(/[\\/]/);
  });
});
