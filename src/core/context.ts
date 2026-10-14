// Context references attached to a prompt (F-12): @file, @folder and editor selections become ACP
// content blocks. Hermes can inline `resource_link` file:// URIs itself, but on native Windows it
// rewrites `C:/...` to a WSL path (`/mnt/c/...`) and cannot read it, so the IDE embeds file text
// itself (images go as image blocks). Selections carry their exact lines; folders become a listing.
import path from "node:path";
import { pathToFileURL } from "node:url";
import type * as acp from "@agentclientprotocol/sdk";
import type { ContextRef } from "../shared/protocol";

export const MAX_FOLDER_ENTRIES = 300;
/** Same cap Hermes applies to attached files. */
export const MAX_FILE_BYTES = 200_000;

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
};

/** What the host read for an @file: text, an image, or nothing usable. */
export type FileContent =
  | { kind: "text"; text: string; truncatedFrom?: number }
  | { kind: "image"; base64: string; mimeType: string }
  | { kind: "binary"; size: number }
  | { kind: "error"; message: string };

/** Decodes file bytes for embedding; NUL bytes mean binary. */
export function decodeFile(filePath: string, bytes: Uint8Array, size = bytes.length): FileContent {
  const mime = IMAGE_MIME[path.extname(filePath).toLowerCase()];
  if (mime) return { kind: "image", base64: Buffer.from(bytes).toString("base64"), mimeType: mime };
  const head = bytes.subarray(0, MAX_FILE_BYTES);
  if (head.includes(0)) return { kind: "binary", size };
  const text = Buffer.from(head).toString("utf8");
  return size > MAX_FILE_BYTES ? { kind: "text", text, truncatedFrom: size } : { kind: "text", text };
}

export function contextLabel(ref: ContextRef, cwd?: string): string {
  if (ref.kind === "codebase") return "codebase";
  if (ref.kind === "image") return ref.width && ref.height ? `${ref.path} ${ref.width}×${ref.height}` : ref.path;
  const rel = cwd ? relative(cwd, ref.path) : ref.path;
  if (ref.kind === "selection" && ref.startLine) {
    return `${path.basename(ref.path)} · ${ref.startLine}${ref.endLine && ref.endLine !== ref.startLine ? `-${ref.endLine}` : ""}`;
  }
  return ref.kind === "folder" ? `${rel.replace(/[\\/]+$/, "")}/` : rel;
}

/** Same reference twice (e.g. the same file mentioned again) is attached once. */
export function dedupeContext(refs: ContextRef[]): ContextRef[] {
  const seen = new Set<string>();
  return refs.filter((r) => {
    const key = `${r.kind}|${r.path.toLowerCase()}|${r.startLine ?? ""}|${r.endLine ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function buildPromptBlocks(
  text: string,
  refs: ContextRef[],
  opts: { cwd?: string; folderListing?: (folder: string) => string[]; readFile?: (file: string) => FileContent } = {},
): acp.ContentBlock[] {
  const blocks: acp.ContentBlock[] = [];
  for (const ref of dedupeContext(refs)) {
    // @codebase is expanded into search hits by the host before this point.
    if (ref.kind === "codebase") continue;
    if (ref.kind === "image") {
      if (!ref.data || !ref.mimeType) continue;
      blocks.push({ type: "text", text: `[Pasted image: ${ref.path}${ref.width && ref.height ? ` (${ref.width}×${ref.height})` : ""}]` });
      blocks.push({ type: "image", data: ref.data, mimeType: ref.mimeType });
      continue;
    }
    const uri = pathToFileURL(ref.path).href;
    const shown = opts.cwd ? relative(opts.cwd, ref.path) : ref.path;
    if (ref.kind === "file") {
      const content = opts.readFile?.(ref.path);
      if (!content) {
        blocks.push({ type: "resource_link", uri, name: path.basename(ref.path), title: shown });
      } else if (content.kind === "image") {
        blocks.push({ type: "text", text: `[Attached image: ${shown}]` });
        blocks.push({ type: "image", data: content.base64, mimeType: content.mimeType, uri });
      } else {
        const body =
          content.kind === "text"
            ? content.text + (content.truncatedFrom ? `
[truncated to ${MAX_FILE_BYTES} of ${content.truncatedFrom} bytes]` : "")
            : content.kind === "binary"
              ? `[Binary file omitted: ${content.size} bytes]`
              : `[Could not read attached file: ${content.message}]`;
        blocks.push({ type: "resource", resource: { uri, mimeType: "text/plain", text: `File ${shown}:
${body}` } });
      }
    } else if (ref.kind === "selection") {
      const range = ref.startLine ? `#L${ref.startLine}${ref.endLine ? `-L${ref.endLine}` : ""}` : "";
      blocks.push({
        type: "resource",
        resource: {
          uri: uri + range,
          mimeType: "text/plain",
          text: `Selection from ${opts.cwd ? relative(opts.cwd, ref.path) : ref.path}, lines ${ref.startLine}-${ref.endLine}:\n${ref.text ?? ""}`,
        },
      });
    } else {
      const entries = (opts.folderListing?.(ref.path) ?? []).slice(0, MAX_FOLDER_ENTRIES);
      const more = (opts.folderListing?.(ref.path).length ?? 0) > MAX_FOLDER_ENTRIES ? "\n…" : "";
      blocks.push({
        type: "resource",
        resource: {
          uri,
          mimeType: "text/plain",
          text: `Folder ${opts.cwd ? relative(opts.cwd, ref.path) : ref.path}/ (${entries.length} files listed; read the ones you need):\n${entries.map((e) => `- ${e}`).join("\n")}${more}`,
        },
      });
    }
  }
  blocks.push({ type: "text", text });
  return blocks;
}

function relative(cwd: string, p: string): string {
  const rel = path.relative(cwd, p);
  return !rel || rel.startsWith("..") || path.isAbsolute(rel) ? p : rel.split(path.sep).join("/");
}

/** Fuzzy subsequence score for @-mention search; higher is better, -1 means no match. */
export function fuzzyScore(query: string, candidate: string): number {
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  if (!q) return 1;
  const base = c.slice(c.lastIndexOf("/") + 1);
  if (base.startsWith(q)) return 1000 - c.length;
  if (c.includes(q)) return 500 - c.indexOf(q) - c.length / 10;
  let score = 0;
  let pos = 0;
  for (const ch of q) {
    const idx = c.indexOf(ch, pos);
    if (idx === -1) return -1;
    score += idx === pos ? 3 : 1;
    pos = idx + 1;
  }
  return score - c.length / 20;
}
