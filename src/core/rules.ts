// Project rules (phase 5): `.hermes/rules.md` and `.hermes/rules/*.md` in the workspace are put in front of the agent
// automatically, so conventions do not have to be repeated in every prompt. Hermes itself also loads AGENTS.md,
// CLAUDE.md, .cursorrules and .hermes.md; these files are the IDE's own, extra layer and are shown in the panel.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";

export const RULES_FILE = ".hermes/rules.md";
export const RULES_DIR = ".hermes/rules";
/** Rules are sent with the first prompt of a session, so they are capped to keep that cheap. */
export const MAX_RULES_BYTES = 16_000;
const MAX_RULE_FILES = 20;
const MAX_FILE_READ = 64_000;

export interface RulesSource {
  /** Workspace-relative path with forward slashes. */
  path: string;
  text: string;
}

export interface ProjectRules {
  files: { path: string; bytes: number }[];
  /** Combined text as sent to the agent (already capped). */
  text: string;
  truncated: boolean;
  /** Changes whenever the effective rules change; decides when they are re-sent. */
  hash: string;
}

/** BOM, CRLF and trailing whitespace would only make the same rules look different. */
function clean(text: string): string {
  return text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").trim();
}

/** Combines rule files into one block. Returns undefined when there is nothing but whitespace. */
export function assembleRules(sources: RulesSource[], maxBytes = MAX_RULES_BYTES): ProjectRules | undefined {
  const usable = sources.map((s) => ({ path: s.path, text: clean(s.text) })).filter((s) => s.text);
  if (!usable.length) return undefined;
  const multiple = usable.length > 1;
  let text = usable.map((s) => (multiple ? `## ${s.path}\n\n${s.text}` : s.text)).join("\n\n");
  let truncated = false;
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    // Cut on a byte budget without splitting a character.
    text = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8").replace(/�+$/, "");
    text += "\n…[rules truncated]";
    truncated = true;
  }
  return {
    files: usable.map((s) => ({ path: s.path, bytes: Buffer.byteLength(s.text, "utf8") })),
    text,
    truncated,
    hash: createHash("sha256").update(text).digest("hex").slice(0, 16),
  };
}

/** Reads the rule files of a workspace. Missing files are normal; unreadable ones are skipped. */
export function loadProjectRules(root: string): ProjectRules | undefined {
  if (!root) return undefined;
  const sources: RulesSource[] = [];
  const read = (rel: string): void => {
    try {
      const abs = path.join(root, ...rel.split("/"));
      const stat = statSync(abs);
      if (!stat.isFile()) return;
      // Over the read limit the file is cut; the overall cap in assembleRules still applies.
      const buffer = readFileSync(abs).subarray(0, MAX_FILE_READ);
      sources.push({ path: rel, text: buffer.toString("utf8") });
    } catch {
      // absent or unreadable
    }
  };
  read(RULES_FILE);
  const dir = path.join(root, ...RULES_DIR.split("/"));
  if (existsSync(dir)) {
    try {
      const names = readdirSync(dir).filter((n) => /\.(md|markdown|txt)$/i.test(n)).sort((a, b) => a.localeCompare(b));
      for (const name of names.slice(0, MAX_RULE_FILES)) read(`${RULES_DIR}/${name}`);
    } catch {
      // directory vanished between existsSync and readdirSync
    }
  }
  return assembleRules(sources);
}

/** The block prepended to a prompt. The tags let replayed sessions hide it again (see stripProjectRules). */
export function rulesNote(rules: ProjectRules): string {
  const from = rules.files.map((f) => f.path).join(", ");
  return [
    `<project-rules source="${from}">`,
    "The user keeps these rules for this project. Follow them for everything you do in this workspace; where they conflict with your defaults, the rules win.",
    "",
    rules.text,
    "</project-rules>",
  ].join("\n");
}

/** Sent when the rules file disappeared after the agent was already given its content. */
export const RULES_REMOVED_NOTE = "<project-rules removed=\"true\">The project rules from earlier in this conversation no longer apply.</project-rules>";

/** Removes IDE-injected rules blocks from replayed user messages, including an unfinished one mid-stream. */
export function stripProjectRules(text: string): string {
  return text.replace(/<project-rules\b[\s\S]*?(?:<\/project-rules>\s*|$)/g, "");
}

export const RULES_TEMPLATE: Record<"id" | "en", string> = {
  id: `# Aturan proyek

Isi file ini otomatis dikirim ke Hermes di awal setiap sesi (dan lagi bila file ini berubah).
Tulis hal yang selalu berlaku di proyek ini. Hapus contoh yang tidak relevan.

## Gaya kode
- Ikuti gaya yang sudah ada di file sekitarnya; jangan merapikan kode yang tidak diminta.
- Tulis komentar seperlunya, dan hanya untuk menjelaskan alasan, bukan apa yang jelas dari kodenya.

## Cara bekerja
- Jalankan tes yang relevan setelah mengubah kode (isi perintah tesnya di sini).
- Jangan menambah dependensi baru tanpa bertanya dulu.
- Jangan menjalankan perintah yang menghapus data atau mengubah git history.
`,
  en: `# Project rules

The contents of this file are sent to Hermes at the start of every session (and again when this file changes).
Write what always holds in this project. Delete the examples that do not apply.

## Code style
- Follow the style of the surrounding files; do not reformat code you were not asked to touch.
- Comment sparingly, and only to explain why, not what the code already says.

## How to work
- Run the relevant tests after changing code (put the test command here).
- Do not add new dependencies without asking first.
- Do not run commands that delete data or rewrite git history.
`,
};
