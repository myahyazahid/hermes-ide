// Builds the standalone Hermes IDE (phase 4): VSCodium + branding + the bundled extension, then a Windows installer
// and the update feed. No VS Code source is forked or patched; only product.json, launchers, icons and exe metadata.
//
//   node ide/scripts/build.mjs [--arch x64|arm64] [--version X.Y.Z] [--release] [--stage-only] [--skip-package] [--vsix path]
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { rcedit } from "rcedit";
import { renderIcons } from "./icons.mjs";
import {
  buildFeed,
  hermesInstallCommand,
  installerFileName,
  issDefines,
  patchProduct,
  platformKey,
  rewriteCmdLauncher,
  rewriteShLauncher,
  visualElementsManifest,
  windowsFileVersion,
} from "./lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function parseArgs(argv) {
  const args = { arch: "x64", release: false, stageOnly: false, skipPackage: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--arch") args.arch = argv[++i];
    else if (a === "--version") args.version = argv[++i];
    else if (a === "--vsix") args.vsix = argv[++i];
    else if (a === "--release") args.release = true;
    else if (a === "--stage-only") args.stageOnly = true;
    else if (a === "--skip-package") args.skipPackage = true;
    // Test hook: replaces the official installer command so the installer's "Install Hermes" task can be exercised
    // without installing anything, and pretends Hermes is missing.
    else if (a === "--hermes-install-command") args.hermesInstallCommand = argv[++i];
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!["x64", "arm64"].includes(args.arch)) throw new Error(`--arch must be x64 or arm64, got ${args.arch}`);
  return args;
}

const log = (msg) => console.log(`[ide] ${msg}`);

function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { stdio: "inherit", cwd: root, ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} exited with ${r.status}`);
}

async function sha256File(file) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), async function* (source) {
    for await (const chunk of source) hash.update(chunk);
  });
  return hash.digest("hex");
}

async function download(url, dest, sha256) {
  log(`Downloading ${url}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}): ${url}`);
  const total = Number(res.headers.get("content-length") ?? 0);
  const hash = createHash("sha256");
  const part = `${dest}.part`;
  let received = 0;
  let lastPct = -1;
  await pipeline(Readable.fromWeb(res.body), async function* (source) {
    for await (const chunk of source) {
      hash.update(chunk);
      received += chunk.length;
      const pct = total ? Math.floor((received / total) * 10) * 10 : -1;
      if (pct !== lastPct && pct >= 0) {
        lastPct = pct;
        log(`  ${pct}%`);
      }
      yield chunk;
    }
  }, createWriteStream(part));
  const digest = hash.digest("hex");
  if (digest !== sha256) {
    rmSync(part, { force: true });
    throw new Error(`Checksum mismatch for ${url}\n  expected ${sha256}\n  got      ${digest}`);
  }
  renameSync(part, dest);
}

/** Downloads the pinned VSCodium zip into ide/.cache (reused when its checksum still matches). */
async function ensureBase(brand, arch) {
  const asset = brand.base.assets[arch];
  if (!asset) throw new Error(`brand.json has no base asset for ${arch}`);
  const cacheDir = path.join(root, "ide", ".cache");
  mkdirSync(cacheDir, { recursive: true });
  const zip = path.join(cacheDir, asset.file);
  if (existsSync(zip) && (await sha256File(zip)) === asset.sha256) {
    log(`Using cached ${asset.file}`);
    return zip;
  }
  rmSync(zip, { force: true });
  await download(`${brand.base.downloadBase}/${brand.base.version}/${asset.file}`, zip, asset.sha256);
  return zip;
}

function unzip(zip, dest) {
  mkdirSync(dest, { recursive: true });
  if (process.platform === "win32") {
    // bsdtar ships with Windows 10+ and reads zip; the `tar` on PATH may be GNU tar (Git Bash), which cannot.
    run(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"), ["-xf", zip, "-C", dest]);
  } else {
    run("unzip", ["-q", zip, "-d", dest]);
  }
}

function packageExtension(args, pkg) {
  if (args.vsix) return path.resolve(args.vsix);
  const vsix = path.join(root, `${pkg.name}-${pkg.version}.vsix`);
  if (!args.skipPackage) run("npm run package", [], { shell: true });
  if (!existsSync(vsix)) throw new Error(`Extension package not found: ${vsix} (run without --skip-package)`);
  return vsix;
}

async function stageIde({ brand, pkg, args, version }) {
  const arch = args.arch;
  const out = path.join(root, "ide", "out", arch);
  const stage = path.join(out, "stage");
  const exe = `${brand.name}.exe`;

  const vsix = packageExtension(args, pkg);
  const zip = await ensureBase(brand, arch);

  log(`Extracting base into ${path.relative(root, stage)}`);
  rmSync(out, { recursive: true, force: true });
  unzip(zip, stage);

  const app = path.join(stage, "resources", "app");
  const baseProduct = JSON.parse(readFileSync(path.join(app, "product.json"), "utf8"));
  if (baseProduct.version !== brand.base.version) {
    throw new Error(`Base product.json is ${baseProduct.version} but brand.json pins ${brand.base.version}`);
  }

  // Extension, shipped as a built-in. A newer copy from Open VSX installed by the user still takes precedence.
  log(`Bundling ${path.basename(vsix)} as a built-in extension`);
  const vsixDir = mkdtempSync(path.join(tmpdir(), "hermes-vsix-"));
  try {
    unzip(vsix, vsixDir);
    const extTarget = path.join(app, "extensions", brand.extensionDir);
    cpSync(path.join(vsixDir, "extension"), extTarget, { recursive: true });
  } finally {
    rmSync(vsixDir, { recursive: true, force: true });
  }

  // Branding.
  const product = patchProduct(baseProduct, brand, { version, arch });
  writeFileSync(path.join(app, "product.json"), JSON.stringify(product, null, 2) + "\n");

  renameSync(path.join(stage, "VSCodium.exe"), path.join(stage, exe));
  rmSync(path.join(stage, "VSCodium.VisualElementsManifest.xml"));
  writeFileSync(path.join(stage, `${brand.name}.VisualElementsManifest.xml`), visualElementsManifest(brand));
  rmSync(path.join(stage, "policies"), { recursive: true, force: true }); // admx/adml are named and worded after VSCodium

  const bin = path.join(stage, "bin");
  writeFileSync(path.join(bin, `${brand.applicationName}.cmd`), rewriteCmdLauncher(readFileSync(path.join(bin, "codium.cmd"), "utf8"), brand));
  writeFileSync(path.join(bin, brand.applicationName), rewriteShLauncher(readFileSync(path.join(bin, "codium"), "utf8"), brand));
  renameSync(path.join(bin, "codium-tunnel.exe"), path.join(bin, `${brand.applicationName}-tunnel.exe`));
  rmSync(path.join(bin, "codium.cmd"));
  rmSync(path.join(bin, "codium"));

  // Icons: app icon (also embedded in the exe), tiles, and the installer icon.
  const icons = await renderIcons(path.join(root, "ide", "assets", "icon.svg"));
  const winRes = path.join(app, "resources", "win32");
  writeFileSync(path.join(winRes, "code.ico"), icons.ico);
  writeFileSync(path.join(winRes, "code_70x70.png"), icons.png70);
  writeFileSync(path.join(winRes, "code_150x150.png"), icons.png150);
  const icoPath = path.join(out, "hermes-ide.ico");
  writeFileSync(icoPath, icons.ico);

  const fileVersion = windowsFileVersion(version);
  await rcedit(path.join(stage, exe), {
    icon: icoPath,
    "file-version": fileVersion,
    "product-version": fileVersion,
    "version-string": {
      ProductName: brand.name,
      FileDescription: brand.name,
      CompanyName: brand.publisher,
      LegalCopyright: `Copyright (c) ${brand.publisher}. Built on ${brand.base.name} ${brand.base.version} (MIT).`,
      OriginalFilename: exe,
      InternalFilename: brand.name,
    },
  });

  log(`Staged ${brand.name} ${version} (${arch}) at ${path.relative(root, stage)}`);
  return { out, stage, exe, icoPath };
}

/** Length of the longest file path under `dir`, counted from `dir` itself including the leading separator. */
function longestRelativePath(dir) {
  let longest = 0;
  const walk = (current, prefixLength) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const length = prefixLength + 1 + entry.name.length;
      if (entry.isDirectory()) walk(path.join(current, entry.name), length);
      else longest = Math.max(longest, length);
    }
  };
  walk(dir, 0);
  return longest;
}

function buildInstaller({ brand, args, version, staged }) {
  if (process.platform !== "win32") throw new Error("The installer can only be built on Windows (Inno Setup).");
  const arch = args.arch;
  const hermes = JSON.parse(readFileSync(path.join(root, "src", "shared", "hermesVersions.json"), "utf8"));
  const iscc = path.join(root, "node_modules", "innosetup-compiler", "bin", "ISCC.exe");
  if (!existsSync(iscc)) throw new Error("ISCC.exe not found; run `npm install` first (devDependency innosetup-compiler).");

  const base = installerFileName(arch, version);
  const defines = issDefines({
    AppName: brand.name,
    AppVersion: version,
    AppId: brand.appIds[arch],
    AppUserModelId: brand.appUserModelId,
    RegName: brand.regValueName,
    Publisher: brand.publisher,
    RepoUrl: brand.repository,
    ExeName: staged.exe,
    AppCommand: brand.applicationName,
    MutexName: brand.mutexName,
    Arch: arch,
    StageDir: staged.stage,
    OutputDir: staged.out,
    OutputBase: base.replace(/\.exe$/, ""),
    IconFile: staged.icoPath,
    Compression: args.release ? "lzma2/max" : "lzma2/fast",
    HermesVersion: hermes.tested.version,
    HermesInstallCommand: args.hermesInstallCommand ?? hermesInstallCommand(hermes),
    ...(args.hermesInstallCommand ? { ForceHermesMissing: 1 } : {}),
    // Windows stops at 260 characters and Setup has no long-path support; leave room for Setup's temporary file names.
    MaxAppDirLength: 250 - longestRelativePath(staged.stage),
  });
  const template = readFileSync(path.join(root, "ide", "installer", "hermes-ide.iss"), "utf8");
  const script = path.join(staged.out, "hermes-ide.iss");
  writeFileSync(script, `${defines}\n${template}`);

  log(`Compiling installer (${args.release ? "max" : "fast"} compression)`);
  run(iscc, ["/Q", script]);
  return path.join(staged.out, base);
}

async function writeFeed({ brand, args, version, installer }) {
  const arch = args.arch;
  const sha256 = await sha256File(installer);
  const size = statSync(installer).size;
  writeFileSync(`${installer}.sha256`, `${sha256} *${path.basename(installer)}\n`);

  const feedPath = path.join(root, "ide", "out", "latest.json");
  let installers = {};
  if (existsSync(feedPath)) {
    const prev = JSON.parse(readFileSync(feedPath, "utf8"));
    if (prev.version === version) installers = prev.installers; // keep the other architecture of the same release
  }
  installers[platformKey(arch)] = {
    url: `${brand.update.downloadBase}/v${version}/${path.basename(installer)}`,
    sha256,
    size,
  };
  const feed = buildFeed({ version, releasedAt: new Date().toISOString(), notes: "", installers });
  writeFileSync(feedPath, JSON.stringify(feed, null, 2) + "\n");
  log(`Wrote ${path.relative(root, feedPath)} (${platformKey(arch)} sha256 ${sha256.slice(0, 12)}…)`);
  return { sha256, size };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const brand = JSON.parse(readFileSync(path.join(root, "ide", "brand.json"), "utf8"));
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const version = args.version ?? pkg.version;

  const staged = await stageIde({ brand, pkg, args, version });
  if (args.stageOnly) return;

  const installer = buildInstaller({ brand, args, version, staged });
  const { size } = await writeFeed({ brand, args, version, installer });
  log(`Installer: ${path.relative(root, installer)} (${(size / 1048576).toFixed(1)} MB)`);
}

main().catch((err) => {
  console.error(`[ide] ${err?.stack ?? err}`);
  process.exit(1);
});
