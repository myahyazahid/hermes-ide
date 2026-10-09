import { describe, expect, it } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
import { parsePermission, patchPaths, pickOption } from "../../src/core/permission";

// Shapes below mirror acp_adapter/edit_approval.py and permissions.py in Hermes 0.21.
const editRequest = (rawInput: unknown, diff: { path: string; oldText: string | null; newText: string }): acp.RequestPermissionRequest => ({
  sessionId: "s1",
  toolCall: {
    toolCallId: "edit-approval-1",
    title: `Approve edit: ${diff.path}`,
    kind: "edit",
    status: "pending",
    content: [{ type: "diff", ...diff }],
    rawInput,
  },
  options: [
    { optionId: "allow_once", kind: "allow_once", name: "Allow edit" },
    { optionId: "deny", kind: "reject_once", name: "Deny" },
  ],
});

const commandOptions: acp.PermissionOption[] = [
  { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
  { optionId: "allow_session", kind: "allow_always", name: "Allow for session" },
  { optionId: "allow_always", kind: "allow_always", name: "Allow always" },
  { optionId: "deny", kind: "reject_once", name: "Deny" },
  { optionId: "deny_always", kind: "reject_always", name: "Deny always" },
];

describe("parsePermission", () => {
  it("parses a write_file edit approval", () => {
    const p = parsePermission(editRequest({ tool: "write_file", arguments: { path: "src/a.ts", content: "x" } }, { path: "src/a.ts", oldText: null, newText: "x" }));
    expect(p).toEqual({ variant: "edit", path: "src/a.ts", oldText: null, newText: "x", isPatch: false, paths: ["src/a.ts"] });
  });

  it("recognises multi-file V4A patches", () => {
    const patch = "*** Begin Patch\n*** Update File: a.ts\n@@\n-x\n+y\n*** Add File: b.ts\n+z\n*** End Patch";
    const p = parsePermission(editRequest({ tool: "patch", arguments: { mode: "patch", patch } }, { path: "a.ts, b.ts", oldText: null, newText: patch }));
    expect(p).toMatchObject({ variant: "edit", isPatch: true, path: "a.ts", paths: ["a.ts", "b.ts"] });
  });

  it("parses a dangerous-command approval", () => {
    const p = parsePermission({
      sessionId: "s1",
      toolCall: {
        toolCallId: "perm-check-1", title: "recursive delete: rm -rf build", kind: "execute", status: "pending",
        content: [{ type: "content", content: { type: "text", text: "recursive delete\n$ rm -rf build" } }],
        rawInput: { command: "rm -rf build", description: "recursive delete" },
      },
      options: commandOptions,
    });
    expect(p).toEqual({ variant: "execute", command: "rm -rf build", description: "recursive delete" });
  });

  it("falls back to the content text when rawInput is missing", () => {
    const p = parsePermission({
      sessionId: "s1",
      toolCall: { toolCallId: "t", title: "x", kind: "execute", content: [{ type: "content", content: { type: "text", text: "why\n$ git reset --hard" } }] },
      options: commandOptions,
    });
    expect(p).toMatchObject({ variant: "execute", command: "git reset --hard" });
  });
});

describe("pickOption", () => {
  it("maps UI choices onto Hermes option ids", () => {
    expect(pickOption(commandOptions, "allow_once")?.optionId).toBe("allow_once");
    expect(pickOption(commandOptions, "allow_session")?.optionId).toBe("allow_session");
    expect(pickOption(commandOptions, "reject")?.optionId).toBe("deny");
  });

  it("falls back to option kinds for unfamiliar ids", () => {
    const opts: acp.PermissionOption[] = [
      { optionId: "yes", kind: "allow_once", name: "Yes" },
      { optionId: "no", kind: "reject_once", name: "No" },
    ];
    expect(pickOption(opts, "allow_once")?.optionId).toBe("yes");
    expect(pickOption(opts, "reject")?.optionId).toBe("no");
    expect(pickOption(opts, "allow_session")).toBeUndefined();
  });

  it("extracts paths from V4A move headers", () => {
    expect(patchPaths("*** Move File: a.ts -> b.ts\n*** Delete File: c.ts")).toEqual(["c.ts", "a.ts", "b.ts"]);
  });
});
