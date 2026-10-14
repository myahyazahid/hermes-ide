// "Every terminal command needs permission" (PRD goal 4, user story 4). Hermes itself only asks for
// commands it considers dangerous, and its ACP toolset cannot be changed per session. Hermes does
// run `pre_tool_call` shell hooks, and a hook answering {"action": "approve"} escalates the call
// to Hermes' own human-approval gate, which in ACP is session/request_permission: the same card
// the panel already shows. The hook below is inert unless Hermes was launched by Hermes IDE, so a
// user's Hermes CLI behaves exactly as before.
import { parseDocument, isMap, isSeq, type Document, YAMLMap, YAMLSeq } from "yaml";
import { NETWORK_TOOL_PATTERN } from "./privacy";

export const HOOK_EVENT = "pre_tool_call";
/** Terminal commands (asked about) and the tools that reach the network (blocked in full local mode). */
export const HOOK_MATCHER = `terminal|execute_code|${NETWORK_TOOL_PATTERN}`;
export const HOOK_ENV = "HERMES_IDE_TERMINAL_APPROVAL";
/** Set when full local mode is on: the hook then blocks the network tools instead of ignoring them. */
export const LOCAL_ONLY_ENV = "HERMES_IDE_LOCAL_ONLY";
export const HOOK_SCRIPT_NAME = "hermes-ide-terminal-approval.js";
const MESSAGE_PREFIX = "[hermes-ide] ";

/** Plain CommonJS so any Node (including the one Hermes bundles) can run it. */
export const HOOK_SCRIPT = `// Hermes IDE: asks for permission before every terminal command and, in full local mode, blocks the tools that
// reach the network (pre_tool_call hook). Does nothing unless Hermes was started by Hermes IDE.
"use strict";
const approve = process.env.${HOOK_ENV} === "1";
const localOnly = process.env.${LOCAL_ONLY_ENV} === "1";
if (!approve && !localOnly) process.exit(0);
const crypto = require("crypto");
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (raw += chunk));
process.stdin.on("end", () => {
  let data = {};
  try { data = JSON.parse(raw || "{}"); } catch (_) {}
  const input = data.tool_input || {};
  const tool = String(data.tool_name || "tool");
  if (/^(${NETWORK_TOOL_PATTERN})$/.test(tool)) {
    if (localOnly) process.stdout.write(JSON.stringify({ action: "block", message: ${JSON.stringify(MESSAGE_PREFIX + "Full local mode is on, so ")} + tool + ${JSON.stringify(" (it reaches the network) is blocked. Work from the project files and what you already know.")} }));
    return;
  }
  if (!approve) return;
  const subject = typeof input.command === "string" ? input.command : typeof input.code === "string" ? input.code : JSON.stringify(input);
  const key = crypto.createHash("sha256").update(tool + "\\0" + subject).digest("hex").slice(0, 16);
  process.stdout.write(JSON.stringify({ action: "approve", message: ${JSON.stringify(MESSAGE_PREFIX)} + tool + ": " + subject, rule_key: "hermes-ide:" + key }));
});
`;

/** Command line Hermes runs for the hook; split by Hermes with Windows-aware quoting. */
export function hookCommand(nodePath: string, scriptPath: string): string {
  return `"${nodePath}" "${scriptPath}"`;
}

/** Recovers the real command from an escalated approval's description (see HOOK_SCRIPT). */
export function parseHookDescription(description: string): { tool: string; subject: string } | undefined {
  if (!description.startsWith(MESSAGE_PREFIX)) return undefined;
  const rest = description.slice(MESSAGE_PREFIX.length);
  const sep = rest.indexOf(": ");
  if (sep <= 0) return undefined;
  return { tool: rest.slice(0, sep), subject: rest.slice(sep + 2) };
}

interface HookEntry {
  matcher: string;
  command: string;
  timeout: number;
  fail_closed: boolean;
}

function ourEntry(command: string): HookEntry {
  // fail_closed: if the hook cannot run inside the IDE, block rather than run unasked.
  return { matcher: HOOK_MATCHER, command, timeout: 30, fail_closed: true };
}

const isOurs = (item: unknown): boolean =>
  isMap(item) && String(item.get("command") ?? "").includes(HOOK_SCRIPT_NAME);

const BLOCK_START = "# >>> hermes-ide terminal approval (managed by Hermes IDE) >>>";
const BLOCK_END = "# <<< hermes-ide terminal approval <<<";
const BLOCK_RE = new RegExp(`\\n?${escapeRe(BLOCK_START)}[\\s\\S]*?${escapeRe(BLOCK_END)}\\n?`);
const TOP_LEVEL_HOOKS = /^hooks\s*:/m;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** JSON strings are valid YAML double-quoted scalars (Windows backslashes included). */
function ourBlock(command: string): string {
  const e = ourEntry(command);
  const lines = [
    BLOCK_START,
    "hooks:",
    `  ${HOOK_EVENT}:`,
    `    - matcher: ${JSON.stringify(e.matcher)}`,
    `      command: ${JSON.stringify(e.command)}`,
    `      timeout: ${e.timeout}`,
    `      fail_closed: ${e.fail_closed}`,
    BLOCK_END,
  ];
  return lines.join("\n") + "\n";
}

/**
 * Adds (or replaces) our pre_tool_call entry in a Hermes config.yaml. When the file has no
 * `hooks:` block of its own (the usual case), a marked block is appended and no existing line is
 * touched. Only when the user already has hooks is the YAML edited structurally.
 * Returns the original text when nothing changes.
 */
export function withApprovalHook(configYaml: string, command: string): string {
  if (BLOCK_RE.test(configYaml)) {
    return configYaml.replace(BLOCK_RE, (m) => (m.startsWith("\n") ? "\n" : "") + ourBlock(command));
  }
  if (!TOP_LEVEL_HOOKS.test(configYaml)) {
    const base = configYaml && !configYaml.endsWith("\n") ? `${configYaml}\n` : configYaml;
    return (base ? `${base}\n` : "") + ourBlock(command);
  }
  const doc: Document = parseDocument(configYaml);
  if (!isMap(doc.contents)) doc.contents = doc.createNode({});
  const root = doc.contents as YAMLMap;
  let hooks = root.get("hooks");
  if (!isMap(hooks)) {
    hooks = doc.createNode({}) as YAMLMap;
    root.set("hooks", hooks);
  }
  const hooksMap = hooks as YAMLMap;
  let list = hooksMap.get(HOOK_EVENT);
  if (!isSeq(list)) {
    list = doc.createNode([]) as YAMLSeq;
    hooksMap.set(HOOK_EVENT, list);
  }
  const seq = list as YAMLSeq;
  const existing = seq.items.find(isOurs);
  if (existing && isMap(existing) && existing.get("command") === command && existing.get("fail_closed") === true && existing.get("matcher") === HOOK_MATCHER) {
    return configYaml;
  }
  seq.items = seq.items.filter((i) => !isOurs(i));
  seq.items.push(doc.createNode(ourEntry(command)));
  return doc.toString({ lineWidth: 0 });
}

/** Removes our entry (and the hooks block if it becomes empty). */
export function withoutApprovalHook(configYaml: string): string {
  if (BLOCK_RE.test(configYaml)) return configYaml.replace(BLOCK_RE, "\n").replace(/\n{2,}$/, "\n");
  const doc = parseDocument(configYaml);
  const hooks = isMap(doc.contents) ? (doc.contents as YAMLMap).get("hooks") : undefined;
  if (!isMap(hooks)) return configYaml;
  const seq = hooks.get(HOOK_EVENT);
  if (!isSeq(seq) || !seq.items.some(isOurs)) return configYaml;
  seq.items = seq.items.filter((i) => !isOurs(i));
  if (!seq.items.length) hooks.delete(HOOK_EVENT);
  if (!hooks.items.length) (doc.contents as YAMLMap).delete("hooks");
  return doc.toString({ lineWidth: 0 });
}

export function hasApprovalHook(configYaml: string): boolean {
  if (BLOCK_RE.test(configYaml)) return true;
  try {
    const doc = parseDocument(configYaml);
    const hooks = isMap(doc.contents) ? (doc.contents as YAMLMap).get("hooks") : undefined;
    const seq = isMap(hooks) ? hooks.get(HOOK_EVENT) : undefined;
    return isSeq(seq) && seq.items.some(isOurs);
  } catch {
    return false;
  }
}

/**
 * Hermes only runs hooks listed in `<HERMES_HOME>/shell-hooks-allowlist.json` (first-use consent).
 * Adding our exact command there is the consent; nothing else in the list is touched.
 */
export function withAllowlistEntry(allowlistJson: string, command: string, now = new Date()): string {
  let data: { approvals?: unknown[] } = {};
  try {
    const parsed = JSON.parse(allowlistJson || "{}");
    if (parsed && typeof parsed === "object") data = parsed;
  } catch {
    data = {};
  }
  const approvals = Array.isArray(data.approvals) ? data.approvals : [];
  const others = approvals.filter(
    (e) => !(e && typeof e === "object" && (e as Record<string, unknown>).event === HOOK_EVENT && (e as Record<string, unknown>).command === command),
  );
  const entry = { event: HOOK_EVENT, command, approved_at: now.toISOString().replace(/\.\d{3}Z$/, "Z"), script_mtime_at_approval: null };
  return JSON.stringify({ ...data, approvals: [...others, entry] }, null, 2) + "\n";
}
