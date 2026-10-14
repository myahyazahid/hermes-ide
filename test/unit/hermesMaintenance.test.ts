import { execFile, execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TESTED_HERMES } from "../../src/core/hermesLocator";
import { checkHermesUpdate, installCommand, parseUpdateCheck, runHermes, updateHermes, versionStatus } from "../../src/core/hermesMaintenance";

describe("versionStatus", () => {
  it("places a version relative to the tested range", () => {
    expect(versionStatus("0.21.4")).toBe("tested");
    expect(versionStatus("0.21.0")).toBe("tested");
    expect(versionStatus("0.20.9")).toBe("older");
    expect(versionStatus("0.22.0")).toBe("newer");
    expect(versionStatus("1.0.0")).toBe("newer");
  });

  it("the build onboarding installs is itself inside the tested range", () => {
    expect(versionStatus(TESTED_HERMES.version)).toBe("tested");
    expect(TESTED_HERMES.commit).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("parseUpdateCheck", () => {
  it("reads the real output of `hermes update --check`", () => {
    const out = "→ Fetching from origin...\n☤ Update available: 10709 commits behind origin/main.\n  Run 'hermes update' to install.\n";
    expect(parseUpdateCheck(out)).toMatchObject({ state: "available", behind: 10709 });
  });

  it("recognises an up-to-date install", () => {
    expect(parseUpdateCheck("Already up to date.").state).toBe("current");
    expect(parseUpdateCheck("Hermes is up-to-date (v0.21.6)").state).toBe("current");
  });

  it("never mistakes output it does not understand for 'up to date'", () => {
    expect(parseUpdateCheck("error: could not reach origin").state).toBe("unknown");
    expect(parseUpdateCheck("").state).toBe("unknown");
  });
});

describe("installCommand", () => {
  it("pins the tested commit by default", () => {
    expect(installCommand()).toBe(
      `& ([scriptblock]::Create((Invoke-RestMethod -Uri 'https://hermes-agent.nousresearch.com/install.ps1'))) -Commit '${TESTED_HERMES.commit}'`,
    );
  });

  it("refuses anything that could break out of the quoted arguments", () => {
    expect(() => installCommand({ commit: "abc'; calc; '" })).toThrow(/commit/);
    expect(() => installCommand({ commit: "HEAD" })).toThrow(/commit/);
    expect(() => installCommand({ url: "https://x.test/a.ps1' ; calc ; '" })).toThrow(/URL/);
    expect(() => installCommand({ url: "http://evil.test/install.ps1" })).toThrow(/URL/);
    expect(() => installCommand({ url: "file:///C:/x.ps1" })).toThrow(/URL/);
  });
});

describe.skipIf(process.platform !== "win32")("installCommand in PowerShell", () => {
  let server: Server;
  let url: string;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "hermes-install-test-"));
    // Stands in for the real installer: a script with a param block that records how it was called.
    const stub = `[CmdletBinding(PositionalBinding=$false)]
param([string]$Branch = "main", [string]$Commit = "", [switch]$NonInteractive)
Set-Content -Path "$env:STUB_OUT" -Value "commit=$Commit branch=$Branch noninteractive=$NonInteractive"
`;
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(stub);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/install.ps1`;
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  });

  it("is valid PowerShell", () => {
    const out = execFileSync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", "$e = $null; $t = $null; [System.Management.Automation.Language.Parser]::ParseInput($env:CMD, [ref]$t, [ref]$e) | Out-Null; if ($e.Count) { $e | ForEach-Object { $_.Message }; exit 1 }; 'ok'"],
      { env: { ...process.env, CMD: installCommand() }, encoding: "utf8" },
    );
    expect(out.trim()).toBe("ok");
  });

  // Async on purpose: a synchronous exec would block this process's event loop, and with it the stub server PowerShell calls.
  it("downloads the script and passes the pinned commit to its param block", async () => {
    const out = path.join(dir, "out.txt");
    await promisify(execFile)("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", installCommand({ url })], {
      env: { ...process.env, STUB_OUT: out },
    });
    expect(readFileSync(out, "utf8").trim()).toBe(`commit=${TESTED_HERMES.commit} branch=main noninteractive=False`);
  });
});

describe("running the Hermes CLI", () => {
  let dir: string;
  let fake: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "hermes-fake-cli-"));
    const js = path.join(dir, "fake-hermes.js");
    writeFileSync(js, `
const args = process.argv.slice(2);
console.log("args:" + args.join(" "));
if (args[0] === "update" && args[1] === "--check") { console.log("☤ Update available: 7 commits behind origin/main."); process.exit(0); }
if (args[0] === "update" && args.includes("--yes")) { console.error("updating..."); console.log("done"); process.exit(Number(process.env.FAKE_EXIT ?? 0)); }
if (args[0] === "hang") setInterval(() => {}, 1000);
else process.exit(3);
`);
    if (process.platform === "win32") {
      fake = path.join(dir, "fake-hermes.cmd");
      writeFileSync(fake, `@echo off\r\nnode "%~dp0fake-hermes.js" %*\r\n`);
    } else {
      fake = path.join(dir, "fake-hermes");
      writeFileSync(fake, `#!/bin/sh\nexec node "$(dirname "$0")/fake-hermes.js" "$@"\n`);
      chmodSync(fake, 0o755);
    }
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("checks for an update without installing", async () => {
    const check = await checkHermesUpdate(fake);
    expect(check).toMatchObject({ state: "available", behind: 7 });
    expect(check.raw).toContain("args:update --check");
  });

  it("updates with a full backup and no prompts, streaming output", async () => {
    const chunks: string[] = [];
    const run = await updateHermes(fake, undefined, (c) => chunks.push(c));
    expect(run.code).toBe(0);
    expect(run.output).toContain("args:update --backup --yes");
    expect(run.output).toContain("updating...");
    expect(chunks.join("")).toContain("done");
  });

  it("reports a failing update as such", async () => {
    const run = await updateHermes(fake, { ...process.env, FAKE_EXIT: "1" });
    expect(run.code).toBe(1);
  });

  it("turns a failed check into 'unknown', not 'current'", async () => {
    const run = await checkHermesUpdate(path.join(dir, "does-not-exist"));
    expect(run.state).toBe("unknown");
  });

  it("kills a command that hangs", async () => {
    const run = await runHermes(fake, ["hang"], { timeoutMs: 800 });
    expect(run.timedOut).toBe(true);
  }, 20_000);

  it("reports a missing executable instead of throwing", async () => {
    const run = await runHermes(path.join(dir, "nope.exe"), ["x"]);
    expect(run.code).toBeNull();
  });
});
