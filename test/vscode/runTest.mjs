// Launches the installed VS Code with this extension and a throwaway profile, then runs
// test/vscode/suite.ts inside the extension host. Usage: npm run test:vscode
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

const mock = await startOpenAIMock({ models: [{ id: "mock-model", context_length: 128000 }] });
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
    extensionTestsEnv: { HERMES_IT_MOCK_URL: mock.baseUrl },
  });
} catch (error) {
  console.error(`VS Code tests failed: ${error?.message ?? error}`);
  code = 1;
} finally {
  await mock.close();
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
process.exit(code);
