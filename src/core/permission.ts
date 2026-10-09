// Classifies Hermes' `session/request_permission` calls. Hermes sends two shapes:
//  - edit approval (kind "edit"): one diff block {path, oldText, newText}; options allow_once/deny.
//    For multi-file V4A patches `newText` is the raw patch and `path` a comma-joined list.
//  - command approval (kind "execute"): rawInput {command, description}; options among
//    allow_once / allow_session / allow_always / deny / deny_always.
import type * as acp from "@agentclientprotocol/sdk";
import { parseHookDescription } from "./terminalApproval";

export type ParsedPermission =
  | {
      variant: "edit";
      path: string;
      oldText: string | null;
      newText: string;
      /** newText is a V4A patch, not file content: only whole accept/reject is possible. */
      isPatch: boolean;
      paths: string[];
    }
  | {
      variant: "execute";
      command: string;
      description: string;
      /** Raised by the IDE's pre_tool_call hook (every command), not by Hermes' danger check. */
      viaHook?: boolean;
      tool?: string;
    }
  | { variant: "other"; title: string };

export function parsePermission(req: acp.RequestPermissionRequest): ParsedPermission {
  const call = req.toolCall;
  const raw = (call.rawInput ?? {}) as Record<string, unknown>;

  const diff = call.content?.find((c): c is acp.ToolCallContent & { type: "diff" } => c.type === "diff");
  if (diff) {
    const args = (raw.arguments ?? {}) as Record<string, unknown>;
    const isPatch = raw.tool === "patch" && args.mode === "patch";
    const paths = isPatch ? patchPaths(String(args.patch ?? diff.newText)) : [diff.path];
    return {
      variant: "edit",
      path: isPatch && paths.length ? paths[0] : diff.path,
      oldText: diff.oldText ?? null,
      newText: diff.newText,
      isPatch,
      paths: paths.length ? paths : [diff.path],
    };
  }

  if (call.kind === "execute" || typeof raw.command === "string") {
    const description = typeof raw.description === "string" ? raw.description : "";
    // Hook escalations carry a synthetic "<terminal> (plugin approval rule)" target; the real
    // command travels in the description the hook wrote.
    const hooked = parseHookDescription(description) ?? parseHookDescription(call.title ?? "");
    if (hooked) return { variant: "execute", command: hooked.subject, description: "", viaHook: true, tool: hooked.tool };
    const command = typeof raw.command === "string" ? raw.command : commandFromContent(call) ?? call.title ?? "";
    return { variant: "execute", command, description };
  }

  return { variant: "other", title: call.title ?? "Permission request" };
}

function commandFromContent(call: acp.ToolCallUpdate): string | undefined {
  for (const c of call.content ?? []) {
    if (c.type === "content" && c.content.type === "text") {
      const m = /^\$ (.+)$/m.exec(c.content.text);
      if (m) return m[1];
    }
  }
  return undefined;
}

const V4A_FILE = /^\*\*\*\s+(?:Update|Add|Delete)\s+File:\s*(.+)$/gm;
const V4A_MOVE = /^\*\*\*\s+Move\s+File:\s*(.+?)\s*->\s*(.+)$/gm;

export function patchPaths(patch: string): string[] {
  const out: string[] = [];
  for (const m of patch.matchAll(V4A_FILE)) out.push(m[1].trim());
  for (const m of patch.matchAll(V4A_MOVE)) out.push(m[1].trim(), m[2].trim());
  return [...new Set(out.filter(Boolean))];
}

export type Choice = "allow_once" | "allow_session" | "allow_always" | "reject";

/** Maps a UI choice to one of the options Hermes offered, by id first and then by ACP kind. */
export function pickOption(options: acp.PermissionOption[], choice: Choice): acp.PermissionOption | undefined {
  const byId = options.find((o) => o.optionId === (choice === "reject" ? "deny" : choice));
  if (byId) return byId;
  const kinds: Record<Choice, acp.PermissionOptionKind[]> = {
    allow_once: ["allow_once"],
    allow_session: ["allow_always"],
    allow_always: ["allow_always"],
    reject: ["reject_once", "reject_always"],
  };
  return options.find((o) => kinds[choice].includes(o.kind));
}

export function selected(option: acp.PermissionOption | undefined): acp.RequestPermissionResponse {
  return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } };
}

export function cancelled(): acp.RequestPermissionResponse {
  return { outcome: { outcome: "cancelled" } };
}
