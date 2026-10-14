// Images a tool call produced or looked at, shown on its card like Claude Code does (a screenshot the agent took,
// a PNG it read). Hermes runs its tools itself, so the IDE only sees paths: in the call's locations, its input
// (e.g. the command) or its output text. A path the agent read is shown as is; a path that only turns up in a
// command or its output is shown only if the file was written while the tool ran, so `ls *.png` shows nothing.
import fs from "node:fs";
import path from "node:path";
import type { ToolImage, TranscriptItem } from "../shared/protocol";
import { IMAGE_MIME } from "./context";

type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;

export type ToolImageFinder = (tool: ToolItem) => ToolImage[];

export const MAX_TOOL_IMAGES = 4;
export const MAX_TOOL_IMAGE_BYTES = 8_000_000;
/** Clock slack for "written while the tool ran". */
const FRESH_SLACK_MS = 2000;

const IMAGE_PATH = /(?:[A-Za-z]:)?[^\s"'`<>|*?:,;()[\]{}=]*\.(?:png|jpe?g|gif|webp)(?![\w.])/gi;

/** Image-file paths mentioned in free text (commands, tool output). */
export function imagePathsIn(text: string): string[] {
  return [...new Set([...text.matchAll(IMAGE_PATH)].map((m) => m[0]).filter((p) => /[\\/]|^[\w.-]+\.\w+$/.test(p)))];
}

function resolve(p: string, cwd: string | undefined): string {
  const wsl = /^\/mnt\/([a-z])\/(.*)$/i.exec(p);
  if (wsl && process.platform === "win32") p = `${wsl[1].toUpperCase()}:/${wsl[2]}`;
  return path.isAbsolute(p) || !cwd ? path.normalize(p) : path.resolve(cwd, p);
}

export function createToolImageFinder(cwd: () => string | undefined): ToolImageFinder {
  return (tool) => {
    const base = cwd();
    const viewed = tool.toolKind === "execute" ? [] : [...tool.paths, ...imagePathsIn(tool.input ?? "")];
    const mentioned = [...(tool.toolKind === "execute" ? imagePathsIn(tool.input ?? "") : []), ...imagePathsIn(tool.detail ?? "")];
    const out: ToolImage[] = [];
    const seen = new Set<string>();
    const consider = (p: string, mustBeFresh: boolean) => {
      if (out.length >= MAX_TOOL_IMAGES) return;
      const mime = IMAGE_MIME[path.extname(p).toLowerCase()];
      if (!mime) return;
      const file = resolve(p, base);
      const key = file.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      try {
        const stat = fs.statSync(file);
        if (!stat.isFile() || stat.size === 0 || stat.size > MAX_TOOL_IMAGE_BYTES) return;
        if (mustBeFresh && stat.mtimeMs < tool.startedAt - FRESH_SLACK_MS) return;
        out.push({ src: `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`, name: path.basename(file), path: file });
      } catch {
        // Missing or unreadable: the path was only text.
      }
    };
    for (const p of viewed) consider(p, false);
    for (const p of mentioned) consider(p, true);
    return out;
  };
}
