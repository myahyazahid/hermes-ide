import { describe, expect, it } from "vitest";
import { compareVersions, isSupportedVersion, locateHermes, needsShell } from "../../src/core/hermesLocator";

describe("locateHermes", () => {
  const winEnv = { PATH: "C:\\tools;C:\\bin", PATHEXT: ".COM;.EXE;.CMD", LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" };

  it("prefers the configured path when it exists", () => {
    expect(locateHermes({ configuredPath: "D:\\h\\hermes.exe", env: winEnv, platform: "win32", exists: (p) => p === "D:\\h\\hermes.exe" })).toBe("D:\\h\\hermes.exe");
    expect(locateHermes({ configuredPath: "D:\\missing.exe", env: winEnv, platform: "win32", exists: () => false })).toBeUndefined();
  });

  it("searches PATH with PATHEXT on Windows", () => {
    const found = locateHermes({ env: winEnv, platform: "win32", exists: (p) => p === "C:\\bin\\hermes.exe" });
    expect(found).toBe("C:\\bin\\hermes.exe");
  });

  it("falls back to the default install location", () => {
    const expected = "C:\\Users\\u\\AppData\\Local\\hermes\\bin\\hermes.exe";
    expect(locateHermes({ env: winEnv, platform: "win32", exists: (p) => p === expected })).toBe(expected);
    expect(locateHermes({ env: { PATH: "/usr/bin", HOME: "/home/u" }, platform: "linux", exists: (p) => p === "/home/u/.local/bin/hermes" })).toBe("/home/u/.local/bin/hermes");
  });
});

describe("versions", () => {
  it("compares dotted versions", () => {
    expect(compareVersions("0.21.4", "0.21.0")).toBe(1);
    expect(compareVersions("0.21", "0.21.0")).toBe(0);
    expect(compareVersions("0.9.9", "0.10.0")).toBe(-1);
  });

  it("checks the supported range", () => {
    expect(isSupportedVersion("0.21.4")).toBe(true);
    expect(isSupportedVersion("0.22.0")).toBe(false);
    expect(isSupportedVersion("0.20.9")).toBe(false);
  });

  it("knows which launchers need a shell", () => {
    expect(needsShell("C:\\x\\hermes.cmd")).toBe(true);
    expect(needsShell("C:\\x\\hermes.exe")).toBe(false);
  });
});
