// Launches the installed VS Code with this extension and a throwaway profile, then runs
// test/vscode/suite.ts inside the extension host. Usage: npm run test:vscode
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";
import * as esbuild from "esbuild";
import { startOpenAIMock } from "../fixtures/openai-mock.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const vscodeExe =
  process.env.VSCODE_EXE ?? path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Microsoft VS Code", "Code.exe");

await esbuild.build({
  entryPoints: [path.join(root, "test/vscode/suite.ts")],
  outfile: path.join(root, "dist-test/suite.js"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["vscode"],
  logLevel: "warning",
});

const mock = await startOpenAIMock({
  models: [
    { id: "mock-model", context_length: 128000 },
    { id: "mock-model-2", context_length: 128000 },
  ],
});
const tmp = mkdtempSync(path.join(os.tmpdir(), "hermes-ide-vscode-"));
const ws = path.join(tmp, "workspace");
mkdirSync(path.join(ws, ".vscode"), { recursive: true });
writeFileSync(
  path.join(ws, ".vscode", "settings.json"),
  JSON.stringify(
    {
      "hermes.endpoint.mode": "custom",
      "hermes.endpoint.baseUrl": mock.baseUrl,
      "hermes.endpoint.model": "mock-model",
      "hermes.endpoint.contextLength": 128000,
      "hermes.language": "en",
    },
    null,
    2,
  ),
);

// HERMES_IT_HERMES_HOME: a Hermes home that Hermes has already prepared. Hermes 0.21.7 installs a Python runtime for
// every new home, which takes longer than the ACP handshake waits, so a fresh home makes every test time out.
const warmHome = process.env.HERMES_IT_HERMES_HOME;
const linkedHome = path.join(tmp, "user-data", "User", "globalStorage", "yahya.hermes-ide", "hermes-home");
if (warmHome) {
  mkdirSync(path.dirname(linkedHome), { recursive: true });
  symlinkSync(warmHome, linkedHome, "junction");
}

// When this runs from a VS Code terminal the variable is inherited and Code.exe would start as
// plain Node instead of the editor.
delete process.env.ELECTRON_RUN_AS_NODE;

let code = 0;
try {
  await runTests({
    vscodeExecutablePath: vscodeExe,
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(root, "dist-test/suite.js"),
    launchArgs: [
      ws,
      "--disable-extensions",
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
      "--user-data-dir", path.join(tmp, "user-data"),
      "--extensions-dir", path.join(tmp, "extensions"),
    ],
    extensionTestsEnv: {
      HERMES_IT_MOCK_URL: mock.baseUrl,
      // The extension host's execPath is Code.exe, so hand it a real Node for the MCP test server.
      HERMES_IT_NODE: process.execPath,
      HERMES_IT_ECHO: path.join(root, "test/fixtures/mcp-echo.mjs"),
    },
  });
} catch (error) {
  console.error(`VS Code tests failed: ${error?.message ?? error}`);
  code = 1;
} finally {
  const summary = mock.chatRequests().map((r, i) => {
    const b = r.body ?? {};
    const sys = (b.messages ?? []).find((m) => m.role === "system")?.content ?? "";
    const lastUser = [...(b.messages ?? [])].reverse().find((m) => m.role === "user")?.content ?? "";
    return `#${i} tools=${(b.tools ?? []).length} msgs=${(b.messages ?? []).length} sys=${JSON.stringify(String(sys).slice(0, 60))} user=${JSON.stringify(String(typeof lastUser === "string" ? lastUser : JSON.stringify(lastUser)).slice(0, 80))}`;
  });
  writeFileSync(path.join(os.tmpdir(), "hermes-ide-mock-requests.txt"), summary.join(String.fromCharCode(10)));
  await mock.close();
  // Remove only the link, never the prepared home behind it.
  if (warmHome) unlinkSync(linkedHome);
  try {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  } catch (error) {
    // Electron can still hold its user-data files for a moment after exit; the temp folder is not worth failing a passing run.
    console.log(`(could not delete ${tmp}: ${error.code ?? error.message})`);
  }
}
process.exit(code);
