// Builds the extension host bundle (Node, CJS) and the chat webview bundle (browser, IIFE).
import { rmSync } from "node:fs";
import * as esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

// Production bundles ship without source maps; drop stale dev maps so they are not packaged.
if (production) rmSync("dist", { recursive: true, force: true });

const common = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: "info",
};

const builds = [
  {
    ...common,
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.js",
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["vscode"],
  },
  {
    ...common,
    entryPoints: ["webview/src/main.tsx"],
    outfile: "dist/webview.js",
    platform: "browser",
    format: "iife",
    target: "es2022",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": JSON.stringify(production ? "production" : "development") },
  },
];

if (watch) {
  const contexts = await Promise.all(builds.map((b) => esbuild.context(b)));
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
