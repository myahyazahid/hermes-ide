// MCP servers configured in the IDE (F-15), passed to Hermes through ACP session/new and
// session/load so they exist only for IDE sessions and never touch Hermes' own config.
import type * as acp from "@agentclientprotocol/sdk";

export interface McpServerSetting {
  name: string;
  type: "stdio" | "http" | "sse";
  /** stdio */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** http / sse */
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

const NAME = /^[A-Za-z0-9_-]{1,40}$/;

/** Returns a problem key, or undefined when the server definition is usable. */
export function validateMcpServer(s: McpServerSetting, others: McpServerSetting[] = []): string | undefined {
  if (!NAME.test(s.name)) return "mcp.invalidName";
  if (others.some((o) => o !== s && o.name === s.name)) return "mcp.duplicateName";
  if (s.type === "stdio") return s.command?.trim() ? undefined : "mcp.missingCommand";
  try {
    const u = new URL(s.url ?? "");
    return u.protocol === "http:" || u.protocol === "https:" ? undefined : "mcp.invalidUrl";
  } catch {
    return "mcp.invalidUrl";
  }
}

export function sanitizeMcpServers(raw: unknown): McpServerSetting[] {
  if (!Array.isArray(raw)) return [];
  const out: McpServerSetting[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const type = r.type === "http" || r.type === "sse" ? r.type : "stdio";
    const s: McpServerSetting = {
      name: String(r.name ?? "").trim(),
      type,
      command: typeof r.command === "string" ? r.command : undefined,
      args: Array.isArray(r.args) ? r.args.map(String) : undefined,
      env: stringRecord(r.env),
      url: typeof r.url === "string" ? r.url : undefined,
      headers: stringRecord(r.headers),
      enabled: r.enabled !== false,
    };
    if (!validateMcpServer(s, out)) out.push(s);
  }
  return out;
}

export function toAcpMcpServers(servers: McpServerSetting[]): acp.McpServer[] {
  return servers
    .filter((s) => s.enabled !== false)
    .map((s): acp.McpServer => {
      const pairs = (r?: Record<string, string>) => Object.entries(r ?? {}).map(([name, value]) => ({ name, value }));
      if (s.type === "stdio") return { name: s.name, command: s.command!.trim(), args: s.args ?? [], env: pairs(s.env) };
      return { type: s.type, name: s.name, url: s.url!.trim(), headers: pairs(s.headers) };
    });
}

/** Splits an args line like `-y "@scope/server" --dir "C:\\My Files"` into argv, honouring quotes. */
export function splitArgs(line: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const m of line.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function stringRecord(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) if (typeof val === "string") out[k] = val;
  return Object.keys(out).length ? out : undefined;
}
