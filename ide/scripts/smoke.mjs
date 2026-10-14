// Launches a built Hermes IDE (staged folder or installed copy) with throw-away profile folders and checks that the
// bundled extension really activates. Opens a window briefly, then kills it.
//
//   node ide/scripts/smoke.mjs [--dir <folder containing "Hermes IDE.exe">] [--timeout 90]
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Same idea as cleanLaunchEnv in src/core/updater.ts: this shell may be inside VS Code, whose ELECTRON_RUN_AS_NODE would make the IDE run as Node. */
function cleanEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => k !== "ELECTRON_RUN_AS_NODE" && k !== "ELECTRON_NO_ATTACH_CONSOLE" && !k.startsWith("VSCODE_")));
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const brand = JSON.parse(readFileSync(path.join(root, "ide", "brand.json"), "utf8"));

const argv = process.argv.slice(2);
const opt = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const dir = path.resolve(opt("--dir", path.join(root, "ide", "out", "x64", "stage")));
const timeoutMs = Number(opt("--timeout", "90")) * 1000;
const extensionId = "yahya.hermes-ide";

const fail = (msg) => {
  console.error(`[smoke] FAIL: ${msg}`);
  process.exitCode = 1;
};

function findFiles(base, name, out = []) {
  if (!existsSync(base)) return out;
  for (const entry of readdirSync(base)) {
    const full = path.join(base, entry);
    if (statSync(full).isDirectory()) findFiles(full, name, out);
    else if (entry === name) out.push(full);
  }
  return out;
}

async function main() {
  const exe = path.join(dir, `${brand.name}.exe`);
  if (!existsSync(exe)) return fail(`${exe} not found`);

  const product = JSON.parse(readFileSync(path.join(dir, "resources", "app", "product.json"), "utf8"));
  if (product.nameLong !== brand.name || product.updateUrl || !product.hermesIde) return fail("product.json is not branded as expected");
  const bundled = path.join(dir, "resources", "app", "extensions", brand.extensionDir, "package.json");
  if (!existsSync(bundled)) return fail("bundled extension is missing");
  const extVersion = JSON.parse(readFileSync(bundled, "utf8")).version;
  console.log(`[smoke] ${product.nameLong} ${product.hermesIde.version} (${product.hermesIde.arch}), bundled extension ${extVersion}`);

  const ud = mkdtempSync(path.join(tmpdir(), "hermes-smoke-ud-"));
  const ed = mkdtempSync(path.join(tmpdir(), "hermes-smoke-ext-"));
  const child = spawn(exe, ["--user-data-dir", ud, "--extensions-dir", ed, "--log", "trace", "--disable-workspace-trust", "--new-window"], {
    stdio: "ignore",
    env: cleanEnv(process.env),
  });
  let exited = false;
  child.once("exit", () => (exited = true));

  const started = Date.now();
  let activated = false;
  while (Date.now() - started < timeoutMs && !exited) {
    await new Promise((r) => setTimeout(r, 1000));
    for (const log of findFiles(path.join(ud, "logs"), "exthost.log")) {
      const text = readFileSync(log, "utf8");
      if (new RegExp(`_doActivateExtension\\s+${extensionId.replace(".", "\\.")}`, "i").test(text)) activated = true;
    }
    if (activated) break;
  }

  if (!exited) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 1500)); // let Windows release file handles before cleanup
  rmSync(ud, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  rmSync(ed, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });

  if (!activated) return fail(exited ? "the IDE exited before the extension activated" : `extension did not activate within ${timeoutMs / 1000}s`);
  console.log(`[smoke] OK: ${extensionId} activated after ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main().catch((err) => fail(err?.stack ?? String(err)));
