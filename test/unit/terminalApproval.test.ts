import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  HOOK_ENV, HOOK_MATCHER, HOOK_SCRIPT, hasApprovalHook, hookCommand, parseHookDescription, withAllowlistEntry, withApprovalHook,
  withoutApprovalHook,
} from "../../src/core/terminalApproval";

const CMD = hookCommand("C:\\node\\node.exe", "C:\\store\\hermes-ide-terminal-approval.js");

const USER_CONFIG = `# Hermes Agent CLI Configuration
model:
  default: "pateway"   # keep me
  provider: "custom"

# =============
# hooks:
#   pre_tool_call: []
approvals:
  mode: manual
`;

describe("withApprovalHook", () => {
  it("adds the hook and keeps the user's keys and comments", () => {
    const out = withApprovalHook(USER_CONFIG, CMD);
    expect(out).toContain('default: "pateway"   # keep me');
    expect(out).toContain("# Hermes Agent CLI Configuration");
    const parsed = parse(out);
    expect(parsed.approvals.mode).toBe("manual");
    expect(parsed.hooks.pre_tool_call).toEqual([{ matcher: HOOK_MATCHER, command: CMD, timeout: 30, fail_closed: true }]);
    expect(HOOK_MATCHER).toBe("terminal|execute_code|web_search|web_extract|vision_analyze|browser_.*");
    expect(hasApprovalHook(out)).toBe(true);
  });

  it("is idempotent and replaces an outdated entry instead of duplicating it", () => {
    const once = withApprovalHook(USER_CONFIG, CMD);
    expect(withApprovalHook(once, CMD)).toBe(once);
    const moved = withApprovalHook(once, hookCommand("D:\\node.exe", "D:\\new\\hermes-ide-terminal-approval.js"));
    expect(parse(moved).hooks.pre_tool_call).toHaveLength(1);
    expect(parse(moved).hooks.pre_tool_call[0].command).toContain("D:\\new");
  });

  it("leaves other hooks alone", () => {
    const withOther = `hooks:\n  pre_tool_call:\n    - command: "/usr/bin/audit.sh"\n  post_tool_call:\n    - command: "/usr/bin/log.sh"\n`;
    const out = parse(withApprovalHook(withOther, CMD));
    expect(out.hooks.pre_tool_call.map((h: { command: string }) => h.command)).toEqual(["/usr/bin/audit.sh", CMD]);
    expect(out.hooks.post_tool_call).toHaveLength(1);
  });

  it("works on an empty file and can be removed again", () => {
    const added = withApprovalHook("", CMD);
    expect(hasApprovalHook(added)).toBe(true);
    const removed = withoutApprovalHook(withApprovalHook(USER_CONFIG, CMD));
    expect(hasApprovalHook(removed)).toBe(false);
    expect(parse(removed).hooks).toBeUndefined();
    expect(withoutApprovalHook(USER_CONFIG)).toBe(USER_CONFIG);
  });
});

// Read-only: the user's real Hermes config is loaded into memory and never written.
const realConfigPath = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), ".hermes-missing"), "hermes", "config.yaml");
describe.skipIf(!existsSync(realConfigPath))("withApprovalHook on the real Hermes config (in memory)", () => {
  it("only appends: every original line is untouched and all other values are identical", () => {
    // If the user already enabled the hook, start from their config without it.
    const original = withoutApprovalHook(readFileSync(realConfigPath, "utf8"));
    const out = withApprovalHook(original, CMD);
    expect(out.startsWith(original)).toBe(true);
    const before = parse(original) ?? {};
    const after = parse(out);
    const { hooks, ...rest } = after;
    expect(rest).toEqual(before);
    expect(hooks.pre_tool_call[0].command).toBe(CMD);
    expect(withoutApprovalHook(out).trimEnd()).toBe(original.trimEnd());
  });
});

describe("withAllowlistEntry", () => {
  it("adds our command once and keeps other approvals", () => {
    const existing = JSON.stringify({ approvals: [{ event: "pre_tool_call", command: "/usr/bin/audit.sh" }] });
    const once = withAllowlistEntry(existing, CMD, new Date("2026-10-09T08:00:00Z"));
    const twice = JSON.parse(withAllowlistEntry(once, CMD));
    expect(twice.approvals.map((e: { command: string }) => e.command)).toEqual(["/usr/bin/audit.sh", CMD]);
    expect(JSON.parse(once).approvals[1]).toMatchObject({ event: "pre_tool_call", approved_at: "2026-10-09T08:00:00Z" });
    expect(JSON.parse(withAllowlistEntry("garbage", CMD)).approvals).toHaveLength(1);
  });
});

describe("hook script", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hook-"));
  const script = path.join(dir, "hook.js");
  writeFileSync(script, HOOK_SCRIPT);
  const run = (payload: object, env: NodeJS.ProcessEnv) =>
    execFileSync(process.execPath, [script], { input: JSON.stringify(payload), env }).toString();

  it("escalates terminal calls to Hermes' approval gate under the IDE", () => {
    const out = JSON.parse(run({ tool_name: "terminal", tool_input: { command: "npm test" } }, { ...process.env, [HOOK_ENV]: "1" }));
    expect(out.action).toBe("approve");
    expect(parseHookDescription(out.message)).toEqual({ tool: "terminal", subject: "npm test" });
    expect(out.rule_key).toMatch(/^hermes-ide:[0-9a-f]{16}$/);
    const code = JSON.parse(run({ tool_name: "execute_code", tool_input: { code: "print(1)" } }, { ...process.env, [HOOK_ENV]: "1" }));
    expect(parseHookDescription(code.message)).toEqual({ tool: "execute_code", subject: "print(1)" });
  });

  it("does nothing outside the IDE", () => {
    const env = { ...process.env };
    delete env[HOOK_ENV];
    expect(run({ tool_name: "terminal", tool_input: { command: "ls" } }, env)).toBe("");
    rmSync(dir, { recursive: true, force: true });
  });

  it("ignores descriptions it did not write", () => {
    expect(parseHookDescription("recursive delete")).toBeUndefined();
    expect(parseHookDescription("[hermes-ide] nocolon")).toBeUndefined();
  });
});
