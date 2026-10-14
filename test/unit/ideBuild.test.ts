import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildFeed,
  encodeIco,
  installerFileName,
  issDefines,
  patchProduct,
  platformKey,
  rewriteCmdLauncher,
  rewriteShLauncher,
  visualElementsManifest,
  windowsFileVersion,
  type Brand,
} from "../../ide/scripts/lib.mjs";

const brand = JSON.parse(readFileSync("ide/brand.json", "utf8")) as Brand;

// A trimmed-down VSCodium product.json carrying the keys the build touches.
const upstream = () => ({
  nameShort: "VSCodium",
  nameLong: "VSCodium",
  applicationName: "codium",
  dataFolderName: ".vscode-oss",
  win32x64UserAppId: "{{2E1F05D1-C245-4562-81EE-28188DB6FD17}",
  updateUrl: "https://raw.githubusercontent.com/VSCodium/versions/refs/heads/master",
  serverDownloadUrlTemplate: "https://github.com/VSCodium/vscodium/releases/download/1/vscodium-reh-${os}-${arch}-1.tar.gz",
  win32ContextMenu: { x64: { clsid: "D910D5E6" } },
  extensionsGallery: { serviceUrl: "https://open-vsx.org/vscode/gallery" },
  checksums: { "vs/workbench/workbench.desktop.main.js": "abc" },
  version: "1.135.06055",
});

describe("brand.json", () => {
  it("pins both base archives by sha256 and uses installer ids of its own", () => {
    for (const asset of Object.values(brand.base.assets)) expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(brand.appIds.x64).not.toBe(brand.appIds.arm64);
    for (const id of Object.values(brand.appIds)) expect(id).toMatch(/^\{\{[0-9A-F-]{36}\}$/); // Inno-escaped GUID
    expect(brand.update.feedUrl.startsWith("https://")).toBe(true);
  });

  it("does not reuse VSCodium identifiers", () => {
    expect(JSON.stringify(brand.appIds)).not.toMatch(/88DA3577|2E1F05D1|67DEE444|57FD70A5/);
    expect(brand.applicationName).not.toBe("codium");
  });
});

describe("patchProduct", () => {
  const product = patchProduct(upstream(), brand, { version: "0.4.0", arch: "x64" });

  it("rebrands names, data folders and ids", () => {
    expect(product).toMatchObject({
      nameShort: "Hermes IDE",
      nameLong: "Hermes IDE",
      applicationName: "hermes-ide",
      dataFolderName: ".hermes-ide",
      win32MutexName: "hermeside",
      tunnelApplicationName: "hermes-ide-tunnel",
      win32x64UserAppId: brand.appIds.x64,
      win32UserAppId: brand.appIds.x64,
      urlProtocol: "hermes-ide",
    });
  });

  it("cuts every link back to VSCodium's update and server infrastructure", () => {
    expect(product).not.toHaveProperty("updateUrl");
    expect(product).not.toHaveProperty("serverDownloadUrlTemplate");
    expect(product).not.toHaveProperty("win32ContextMenu");
    expect(product.downloadUrl).toBe(`${brand.repository}/releases`);
  });

  it("marks the build as the standalone IDE for the extension", () => {
    expect(product.hermesIde).toEqual({ version: "0.4.0", arch: "x64", installer: "user", updateFeedUrl: brand.update.feedUrl });
  });

  it("applies configuration defaults, turning off telemetry and the stock updater", () => {
    expect(product.configurationDefaults).toMatchObject({ "telemetry.telemetryLevel": "off", "update.mode": "none", "chat.disableAIFeatures": true });
  });

  it("keeps the integrity checksums, the product version and Open VSX", () => {
    expect(product.checksums).toEqual(upstream().checksums);
    expect(product.version).toBe("1.135.06055");
    expect(product.extensionsGallery.serviceUrl).toContain("open-vsx.org");
  });

  it("uses the arm64 id for arm64 builds and does not mutate its input", () => {
    const input = upstream();
    const arm = patchProduct(input, brand, { version: "0.4.0", arch: "arm64" });
    expect(arm.win32arm64UserAppId).toBe(brand.appIds.arm64);
    expect(arm.hermesIde.arch).toBe("arm64");
    expect(input.nameLong).toBe("VSCodium");
    expect(input).toHaveProperty("updateUrl");
  });

  it("refuses a base that does not use Open VSX", () => {
    const base = { ...upstream(), extensionsGallery: { serviceUrl: "https://marketplace.visualstudio.com/_apis/public/gallery" } };
    expect(() => patchProduct(base, brand, { version: "0.4.0", arch: "x64" })).toThrow(/Open VSX/);
  });
});

describe("launcher scripts", () => {
  const cmd = '@echo off\r\n"%~dp0..\\VSCodium.exe" "%~dp0..\\resources\\app\\out\\cli.js" %*\r\n';
  const sh = 'COMMIT="1a46"\nAPP_NAME="codium"\nQUALITY="stable"\nNAME="VSCodium"\nSERVERDATAFOLDER=".vscodium-server"\nELECTRON="$VSCODE_PATH/$NAME.exe"\n';

  it("points the cmd launcher at the renamed exe", () => {
    expect(rewriteCmdLauncher(cmd, brand)).toContain('"%~dp0..\\Hermes IDE.exe"');
    expect(rewriteCmdLauncher(cmd, brand)).not.toContain("VSCodium");
  });

  it("rewrites the sh launcher's names", () => {
    const out = rewriteShLauncher(sh, brand);
    expect(out).toContain('APP_NAME="hermes-ide"');
    expect(out).toContain('NAME="Hermes IDE"');
    expect(out).toContain('SERVERDATAFOLDER=".hermes-ide-server"');
    expect(out).not.toMatch(/codium|VSCodium/i);
  });

  it("fails when an upstream launcher changes shape instead of silently shipping a broken one", () => {
    expect(() => rewriteCmdLauncher("@echo off\r\nstart code.exe\r\n", brand)).toThrow(/changed shape/);
    expect(() => rewriteShLauncher('APP_NAME="codium"\n', brand)).toThrow(/changed shape/);
  });

  it("names the tile manifest after the product", () => {
    expect(visualElementsManifest(brand)).toContain('ShortDisplayName="Hermes IDE"');
  });
});

describe("windowsFileVersion", () => {
  it("pads to four numeric parts and drops prerelease tags", () => {
    expect(windowsFileVersion("0.4.0")).toBe("0.4.0.0");
    expect(windowsFileVersion("1.2.3-beta.1")).toBe("1.2.3.0");
    expect(windowsFileVersion("1.2.3.4")).toBe("1.2.3.4");
  });

  it("rejects what Windows cannot represent", () => {
    expect(() => windowsFileVersion("1.x.0")).toThrow();
    expect(() => windowsFileVersion("70000.0.0")).toThrow();
  });
});

describe("encodeIco", () => {
  it("lays out header, directory and PNG payloads", () => {
    const a = Buffer.from("png-a");
    const b = Buffer.from("png-bb");
    const ico = encodeIco([{ size: 16, data: a }, { size: 256, data: b }]);
    expect(ico.readUInt16LE(2)).toBe(1); // icon type
    expect(ico.readUInt16LE(4)).toBe(2); // image count
    expect(ico.readUInt8(6)).toBe(16);
    expect(ico.readUInt8(6 + 16)).toBe(0); // 256 is stored as 0
    const offsetB = ico.readUInt32LE(6 + 16 + 12);
    expect(offsetB).toBe(6 + 32 + a.length);
    expect(ico.subarray(offsetB, offsetB + b.length).equals(b)).toBe(true);
    expect(ico.length).toBe(6 + 32 + a.length + b.length);
  });

  it("validates its input", () => {
    expect(() => encodeIco([])).toThrow();
    expect(() => encodeIco([{ size: 512, data: Buffer.alloc(1) }])).toThrow();
  });
});

describe("release feed and installer naming", () => {
  const sha256 = "c".repeat(64);

  it("builds a feed the updater accepts", () => {
    const feed = buildFeed({
      version: "0.4.0",
      releasedAt: "2026-10-10T00:00:00.000Z",
      installers: { [platformKey("x64")]: { url: `https://example.com/${installerFileName("x64", "0.4.0")}`, sha256, size: 10 } },
    });
    expect(feed.schema).toBe(1);
    expect(feed.installers["win32-x64"].url).toMatch(/HermesIDE-Setup-x64-0\.4\.0\.exe$/);
  });

  it("refuses insecure URLs and malformed hashes", () => {
    expect(() => buildFeed({ version: "1.0.0", releasedAt: "", installers: { "win32-x64": { url: "http://x/a.exe", sha256, size: 1 } } })).toThrow(/https/);
    expect(() => buildFeed({ version: "1.0.0", releasedAt: "", installers: { "win32-x64": { url: "https://x/a.exe", sha256: "XYZ", size: 1 } } })).toThrow(/sha256/);
  });
});

describe("issDefines", () => {
  it("quotes values and doubles embedded quotes", () => {
    expect(issDefines({ AppName: "Hermes IDE", Note: 'say "hi"', Id: "{{ABC}" })).toBe(
      '#define AppName "Hermes IDE"\n#define Note "say ""hi"""\n#define Id "{{ABC}"\n',
    );
  });

  it("rejects names that are not identifiers", () => {
    expect(() => issDefines({ "bad name": "x" })).toThrow();
  });
});
