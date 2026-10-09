// A minimal MCP server (Streamable HTTP, JSON responses only) hosted by the extension on
// 127.0.0.1, so Hermes sessions can call IDE features such as codebase search (F-18) as tools.
// Requests must carry the per-run bearer token; nothing listens on other interfaces.
import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface McpToolResult {
  text: string;
  isError?: boolean;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  call(args: Record<string, unknown>): Promise<McpToolResult>;
}

const PROTOCOL_VERSION = "2025-06-18";

export class McpHttpServer {
  private server: http.Server | undefined;
  readonly token = randomBytes(24).toString("hex");
  url = "";

  constructor(
    private readonly tools: () => McpTool[],
    private readonly info: { name: string; version: string },
    private readonly log: (line: string) => void = () => {},
  ) {}

  async start(): Promise<string> {
    if (this.server) return this.url;
    const server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    this.server = server;
    this.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    return this.url;
  }

  close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return Promise.resolve();
    return new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.headers.authorization !== `Bearer ${this.token}`) return send(res, 401, { error: "unauthorized" });
    if (!req.url?.startsWith("/mcp")) return send(res, 404, { error: "not found" });
    if (req.method === "DELETE") return send(res, 200, {});
    // No server-initiated stream: clients fall back to plain request/response.
    if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });

    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
    }
    const messages = Array.isArray(payload) ? payload : [payload];
    const replies = [];
    for (const m of messages as { id?: unknown; method?: string; params?: Record<string, unknown> }[]) {
      if (m.id === undefined || m.id === null) continue; // notification (e.g. notifications/initialized)
      replies.push(await this.answer(m.id, m.method ?? "", m.params ?? {}));
    }
    if (!replies.length) {
      res.writeHead(202).end();
      return;
    }
    const headers: Record<string, string> = messages.some((m) => (m as { method?: string }).method === "initialize")
      ? { "Mcp-Session-Id": randomBytes(12).toString("hex") }
      : {};
    send(res, 200, Array.isArray(payload) ? replies : replies[0], headers);
  }

  private async answer(id: unknown, method: string, params: Record<string, unknown>): Promise<unknown> {
    const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    switch (method) {
      case "initialize":
        return ok({
          protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: this.info,
        });
      case "ping":
        return ok({});
      case "tools/list":
        return ok({ tools: this.tools().map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      case "tools/call": {
        const tool = this.tools().find((t) => t.name === params.name);
        if (!tool) return { jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool ${String(params.name)}` } };
        try {
          const r = await tool.call((params.arguments ?? {}) as Record<string, unknown>);
          return ok({ content: [{ type: "text", text: r.text }], isError: !!r.isError });
        } catch (error) {
          this.log(`mcp tool ${tool.name} failed: ${(error as Error).message}`);
          return ok({ content: [{ type: "text", text: `Error: ${(error as Error).message}` }], isError: true });
        }
      }
      default:
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } };
    }
  }
}

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}
