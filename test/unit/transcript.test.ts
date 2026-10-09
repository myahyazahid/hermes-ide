import { describe, expect, it } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
import { Transcript } from "../../src/core/transcript";

const text = (sessionUpdate: "agent_message_chunk" | "agent_thought_chunk" | "user_message_chunk", t: string): acp.SessionUpdate =>
  ({ sessionUpdate, content: { type: "text", text: t } }) as acp.SessionUpdate;

describe("Transcript", () => {
  it("merges streamed chunks into one agent message", () => {
    const tr = new Transcript();
    tr.addUser("hi");
    tr.apply(text("agent_message_chunk", "Hel"));
    tr.apply(text("agent_message_chunk", "lo"));
    const items = tr.all();
    expect(items.map((i) => i.kind)).toEqual(["user", "agent"]);
    expect(items[1]).toMatchObject({ text: "Hello", streaming: true });
    tr.endTurn();
    expect(tr.all()[1]).toMatchObject({ streaming: false });
  });

  it("starts a new bubble after a tool card so order is preserved", () => {
    let now = 1000;
    const tr = new Transcript(() => now);
    tr.apply(text("agent_message_chunk", "Reading first."));
    tr.apply({ sessionUpdate: "tool_call", toolCallId: "c1", title: "read_file: a.ts", kind: "read", status: "in_progress", locations: [{ path: "/w/a.ts" }] });
    now = 1200;
    tr.apply({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed" });
    tr.apply(text("agent_message_chunk", "Done."));
    const items = tr.all();
    expect(items.map((i) => i.kind)).toEqual(["agent", "tool", "agent"]);
    expect(items[1]).toMatchObject({ status: "completed", startedAt: 1000, endedAt: 1200, paths: ["/w/a.ts"], toolKind: "read" });
  });

  it("records diff stats and detail text for tool calls", () => {
    const tr = new Transcript();
    tr.apply({
      sessionUpdate: "tool_call", toolCallId: "e1", title: "patch: a.ts", kind: "edit",
      content: [{ type: "diff", path: "/w/a.ts", oldText: "a\nb\n", newText: "a\nB\nc\n" }],
    });
    tr.apply({
      sessionUpdate: "tool_call_update", toolCallId: "e1", status: "failed",
      content: [{ type: "content", content: { type: "text", text: "boom" } }],
    });
    expect(tr.all()[0]).toMatchObject({ added: 2, removed: 1, status: "failed", detail: "boom", paths: ["/w/a.ts"] });
  });

  it("ignores Hermes' synthetic permission bubbles", () => {
    const tr = new Transcript();
    tr.apply({ sessionUpdate: "tool_call_update", toolCallId: "perm-check-3", status: "completed" });
    tr.apply({ sessionUpdate: "tool_call_update", toolCallId: "edit-approval-1", status: "failed" });
    expect(tr.all()).toEqual([]);
  });

  it("surfaces usage and title as side effects, notices as items", () => {
    const tr = new Transcript();
    expect(tr.apply({ sessionUpdate: "usage_update", used: 15000, size: 256000 })).toEqual({ usage: { used: 15000, size: 256000 } });
    expect(tr.apply({ sessionUpdate: "session_info_update", title: "Fix login" })).toEqual({ title: "Fix login" });
    tr.apply({ sessionUpdate: "notice", severity: "warning", title: "Context", description: "almost full" } as acp.SessionUpdate);
    expect(tr.all()[0]).toMatchObject({ kind: "notice", level: "warn", text: "Context: almost full" });
  });

  it("reports only changed items", () => {
    const tr = new Transcript();
    tr.addUser("a");
    tr.apply(text("agent_message_chunk", "x"));
    expect(tr.takeChanges()).toHaveLength(2);
    tr.apply(text("agent_message_chunk", "y"));
    const changes = tr.takeChanges();
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: "agent", text: "xy" });
    expect(tr.takeChanges()).toEqual([]);
  });

  it("replays user chunks from history into user bubbles", () => {
    const tr = new Transcript();
    tr.apply(text("user_message_chunk", "fix "));
    tr.apply(text("user_message_chunk", "it"));
    tr.apply(text("agent_message_chunk", "ok"));
    expect(tr.all().map((i) => [i.kind, "text" in i ? i.text : ""])).toEqual([["user", "fix it"], ["agent", "ok"]]);
  });
});
