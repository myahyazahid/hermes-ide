// Folds ACP session/update notifications into chat transcript items (F-06, F-07). Runs in the
// extension host so the transcript survives webview reloads; the view receives upserts.
import type * as acp from "@agentclientprotocol/sdk";
import type { ToolStatus, TranscriptItem } from "../shared/protocol";
import { diffStat } from "./hunks";

const DETAIL_LIMIT = 4000;

/** Tool-call ids Hermes uses for synthetic permission bubbles; the permission card covers them. */
const SYNTHETIC_TOOL_ID = /^(perm-check|edit-approval)-\d+$/;

/** The fields tool_call and tool_call_update share (the update makes everything optional/nullable). */
interface ToolFields {
  title?: string | null;
  kind?: acp.ToolKind | null;
  status?: acp.ToolCallStatus | null;
  locations?: acp.ToolCallLocation[] | null;
  content?: acp.ToolCallContent[] | null;
}

export interface UpdateSideEffects {
  usage?: { used: number; size: number };
  title?: string;
}

export class Transcript {
  private readonly items: TranscriptItem[] = [];
  private readonly byId = new Map<string, TranscriptItem>();
  private readonly changed = new Set<string>();
  private seq = 0;

  constructor(private readonly now: () => number = Date.now) {}

  all(): TranscriptItem[] {
    return this.items.map((i) => ({ ...i }) as TranscriptItem);
  }

  get(id: string): TranscriptItem | undefined {
    return this.byId.get(id);
  }

  /** Items changed since the last call, in transcript order. */
  takeChanges(): TranscriptItem[] {
    if (!this.changed.size) return [];
    const out = this.items.filter((i) => this.changed.has(i.id)).map((i) => ({ ...i }) as TranscriptItem);
    this.changed.clear();
    return out;
  }

  addUser(text: string): void {
    this.push({ kind: "user", id: this.newId("user"), text });
  }

  addNotice(level: "info" | "warn" | "error", text: string): string {
    const id = this.newId("notice");
    this.push({ kind: "notice", id, level, text });
    return id;
  }

  upsert(item: TranscriptItem): void {
    const existing = this.byId.get(item.id);
    if (existing) {
      Object.assign(existing, item);
      this.changed.add(item.id);
    } else {
      this.push(item);
    }
  }

  patch<K extends TranscriptItem["kind"]>(id: string, kind: K, fields: Partial<Extract<TranscriptItem, { kind: K }>>): void {
    const existing = this.byId.get(id);
    if (!existing || existing.kind !== kind) return;
    Object.assign(existing, fields);
    this.changed.add(id);
  }

  /** Marks streaming text as finished, e.g. when a prompt returns or is cancelled. */
  endTurn(): void {
    for (const item of this.items) {
      if (item.kind === "agent" && item.streaming) {
        item.streaming = false;
        this.changed.add(item.id);
      }
    }
  }

  apply(update: acp.SessionUpdate): UpdateSideEffects {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        this.appendText("agent", update.content);
        return {};
      case "agent_thought_chunk":
        this.appendText("thought", update.content);
        return {};
      case "user_message_chunk":
        this.appendText("user", update.content);
        return {};
      case "tool_call":
        this.applyToolCall(update.toolCallId, update, true);
        return {};
      case "tool_call_update":
        this.applyToolCall(update.toolCallId, update, false);
        return {};
      case "usage_update":
        return { usage: { used: update.used, size: update.size } };
      case "session_info_update":
        return update.title ? { title: update.title } : {};
      case "notice": {
        const level = update.severity === "error" ? "error" : update.severity === "warning" ? "warn" : "info";
        this.addNotice(level, update.description ? `${update.title}: ${update.description}` : update.title);
        return {};
      }
      default:
        return {};
    }
  }

  private appendText(kind: "agent" | "thought" | "user", content: acp.ContentBlock): void {
    const text = content.type === "text" ? content.text : content.type === "image" ? "[image]" : "";
    if (!text) return;
    // Text continues the last bubble only if nothing (e.g. a tool card) came in between, which
    // keeps the transcript in the order things actually happened.
    const last = this.items[this.items.length - 1];
    if (last && last.kind === kind && (kind !== "agent" || (last.kind === "agent" && last.streaming))) {
      last.text += text;
      this.changed.add(last.id);
      return;
    }
    if (kind === "agent") this.push({ kind, id: this.newId(kind), text, streaming: true });
    else this.push({ kind, id: this.newId(kind), text });
  }

  private applyToolCall(toolCallId: string, u: ToolFields, isStart: boolean): void {
    if (SYNTHETIC_TOOL_ID.test(toolCallId)) return;
    const id = `tool:${toolCallId}`;
    let item = this.byId.get(id);
    if (!item || item.kind !== "tool") {
      item = {
        kind: "tool", id, title: u.title ?? "Tool", toolKind: u.kind ?? "other",
        status: "pending", startedAt: this.now(), paths: [],
      };
      this.push(item);
    } else if (isStart) {
      item.startedAt = this.now();
    }
    if (u.title) item.title = u.title;
    if (u.kind) item.toolKind = u.kind;
    if (u.status) {
      item.status = u.status as ToolStatus;
      if (u.status === "completed" || u.status === "failed") item.endedAt = this.now();
    }
    if (u.locations?.length) item.paths = [...new Set(u.locations.map((l) => l.path))];
    for (const c of u.content ?? []) {
      if (c.type === "diff") {
        const stat = diffStat(c.oldText ?? "", c.newText);
        item.added = stat.added;
        item.removed = stat.removed;
        if (!item.paths.includes(c.path)) item.paths.push(c.path);
      } else if (c.type === "content" && c.content.type === "text") {
        item.detail = c.content.text.length > DETAIL_LIMIT ? c.content.text.slice(0, DETAIL_LIMIT) + "\n…" : c.content.text;
      }
    }
    this.changed.add(id);
  }

  private push(item: TranscriptItem): void {
    this.items.push(item);
    this.byId.set(item.id, item);
    this.changed.add(item.id);
  }

  private newId(prefix: string): string {
    return `${prefix}:${++this.seq}`;
  }
}
