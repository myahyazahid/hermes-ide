// Publishes the extension .vsix to Open VSX (https://open-vsx.org), the gallery VSCodium and Hermes IDE use.
// Publishing is public and a version number can never be reused, so this stops at every precondition.
//
//   OVSX_PAT=<token> node ide/scripts/publish-openvsx.mjs [--vsix path] [--dry-run] [--allow-unlicensed]
//
// One-time setup (see README, "Open VSX"): create an Eclipse account, sign the Publisher Agreement, create an access
// token at open-vsx.org, then `npx ovsx create-namespace <publisher> -p <token>`.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OVSX_VERSION = "1.2.0"; // pinned: this tool receives the access token

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const vsix = path.resolve(argv.includes("--vsix") ? argv[argv.indexOf("--vsix") + 1] : path.join(root, `${pkg.name}-${pkg.version}.vsix`));

function stop(message) {
  console.error(`[openvsx] ${message}`);
  process.exit(1);
}

if (!existsSync(vsix)) stop(`${path.basename(vsix)} not found. Run \`npm run package\` first.`);
if (pkg.license === "UNLICENSED" && !argv.includes("--allow-unlicensed")) {
  stop('package.json says "license": "UNLICENSED". Choose a license (PRD open question) before publishing publicly, or pass --allow-unlicensed if that is deliberate.');
}
if (!pkg.repository) console.warn("[openvsx] warning: package.json has no `repository`; the listing will have no source link.");
if (!dryRun && !process.env.OVSX_PAT) stop("Set OVSX_PAT to your Open VSX access token.");

console.log(`[openvsx] ${dryRun ? "(dry run) would publish" : "publishing"} ${path.basename(vsix)} as ${pkg.publisher}.${pkg.name}@${pkg.version}`);
if (dryRun) process.exit(0);

const result = spawnSync("npx", ["--yes", `ovsx@${OVSX_VERSION}`, "publish", vsix], {
  stdio: "inherit",
  shell: true,
  env: process.env, // ovsx reads OVSX_PAT itself, so the token never appears on the command line
});
process.exit(result.status ?? 1);
