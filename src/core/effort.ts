// Reasoning effort in a Hermes config.yaml (`agent.reasoning_effort`). Hermes reads it whenever it builds a session's
// agent (new session, load, model switch) and sends it to the endpoint as `reasoning_effort`; unset means "medium".
// Edited as text, one line, so a user's long hand-written config keeps its comments and layout.
import { EFFORTS, type Effort } from "../shared/protocol";

/** What Hermes uses when the config names no effort. */
export const DEFAULT_EFFORT: Effort = "medium";

export function isEffort(value: unknown): value is Effort {
  return typeof value === "string" && (EFFORTS as readonly string[]).includes(value);
}

interface AgentBlock {
  /** Index of the `agent:` line. */
  start: number;
  /** Index after the block's last line. */
  end: number;
  /** Indentation of the block's keys. */
  indent: string;
  /** Index of the `reasoning_effort:` line, if any. */
  effortLine?: number;
}

const TOP_LEVEL_AGENT = /^agent\s*:\s*(#.*)?$/;
const EFFORT_KEY = /^(\s+)reasoning_effort\s*:(.*)$/;

function findAgentBlock(lines: string[]): AgentBlock | undefined {
  const start = lines.findIndex((l) => TOP_LEVEL_AGENT.test(l));
  if (start < 0) return undefined;
  let end = start + 1;
  let indent: string | undefined;
  let effortLine: number | undefined;
  for (; end < lines.length; end++) {
    const line = lines[end];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (/^\S/.test(line)) break; // the next top-level key
    const own = /^(\s+)/.exec(line)![1];
    indent ??= own;
    const m = EFFORT_KEY.exec(line);
    if (m && m[1] === indent) effortLine = end;
  }
  return { start, end, indent: indent ?? "  ", effortLine };
}

function scalar(raw: string): string {
  const value = raw.replace(/\s+#.*$/, "").trim();
  return value.replace(/^(["'])(.*)\1$/, "$2").trim().toLowerCase();
}

/** The effort a config names, when it is one the slider offers. */
export function readReasoningEffort(yaml: string): Effort | undefined {
  const lines = yaml.split(/\r?\n/);
  const block = findAgentBlock(lines);
  if (block?.effortLine === undefined) return undefined;
  const value = scalar(EFFORT_KEY.exec(lines[block.effortLine])![2]);
  return isEffort(value) ? value : undefined;
}

/** The config with `agent.reasoning_effort` set to `effort`; the original text when it already is. */
export function withReasoningEffort(yaml: string, effort: Effort): string {
  const eol = yaml.includes("\r\n") ? "\r\n" : "\n";
  const lines = yaml.split(/\r?\n/);
  const block = findAgentBlock(lines);
  if (!block) {
    const base = yaml && !yaml.endsWith("\n") ? yaml + eol : yaml;
    return `${base}agent:${eol}  reasoning_effort: "${effort}"${eol}`;
  }
  if (block.effortLine !== undefined) {
    const line = lines[block.effortLine];
    const m = EFFORT_KEY.exec(line)!;
    if (scalar(m[2]) === effort) return yaml;
    const comment = /\s+#.*$/.exec(m[2])?.[0] ?? "";
    lines[block.effortLine] = `${m[1]}reasoning_effort: "${effort}"${comment}`;
  } else {
    lines.splice(block.start + 1, 0, `${block.indent}reasoning_effort: "${effort}"`);
  }
  return lines.join(eol);
}
