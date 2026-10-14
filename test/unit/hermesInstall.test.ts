import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hermesInstallCommand, type HermesVersions } from "../../ide/scripts/lib.mjs";
import { installCommand, versionStatus } from "../../src/core/hermesMaintenance";
import { HERMES_INSTALL, SUPPORTED_HERMES, TESTED_HERMES } from "../../src/shared/hermesVersions";

const versions = JSON.parse(readFileSync("src/shared/hermesVersions.json", "utf8")) as HermesVersions;

describe("Hermes version data", () => {
  it("is the single source the TypeScript constants come from", () => {
    expect(SUPPORTED_HERMES).toEqual(versions.supported);
    expect(TESTED_HERMES).toEqual(versions.tested);
    expect(HERMES_INSTALL).toEqual(versions.install);
  });

  it("pins a full commit that lies inside the supported range", () => {
    expect(versions.tested.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(versionStatus(versions.tested.version)).toBe("tested");
  });

  it("installs from the official https script", () => {
    expect(versions.install.scriptUrl.startsWith("https://hermes-agent.nousresearch.com/")).toBe(true);
    expect(versions.install.commandTemplate).toContain("{url}");
    expect(versions.install.commandTemplate).toContain("{commit}");
  });
});

describe("the installer's Hermes install command", () => {
  it("is exactly what the extension runs from the panel", () => {
    expect(hermesInstallCommand(versions)).toBe(installCommand());
    const custom = { url: "https://example.test/install.ps1", commit: "abcdef1" };
    expect(hermesInstallCommand(versions, custom)).toBe(installCommand(custom));
  });

  it("refuses the same unsafe inputs", () => {
    expect(() => hermesInstallCommand(versions, { commit: "abc'; calc; '" })).toThrow(/commit/);
    expect(() => hermesInstallCommand(versions, { url: "http://evil.test/a.ps1" })).toThrow(/URL/);
    expect(() => hermesInstallCommand(versions, { url: "https://x.test/a.ps1' ; calc ; '" })).toThrow(/URL/);
  });
});
