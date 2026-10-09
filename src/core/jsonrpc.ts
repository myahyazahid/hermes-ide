// Minimal JSON-RPC 2.0 peer over newline-delimited JSON, as used by ACP on stdio.
// Kept transport-agnostic: the caller feeds incoming lines and supplies a line writer.

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }

  static methodNotFound(method: string): RpcError {
    return new RpcError(-32601, `Method not found: ${method}`);
  }
}

export class ConnectionClosedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ConnectionClosedError";
  }
}

export interface JsonRpcHandlers {
  /** Incoming request from the other side; resolve with the result or throw an RpcError. */
  onRequest(method: string, params: unknown): Promise<unknown>;
  onNotification(method: string, params: unknown): void;
  /** Non-JSON or malformed lines; stdout must stay clean for ACP, so these are worth logging. */
  onProtocolError?(line: string, error: unknown): void;
}

interface Pending {
  method: string;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timer?: ReturnType<typeof setTimeout>;
}

type Id = number | string;

export class JsonRpcPeer {
  private nextId = 1;
  private readonly pending = new Map<Id, Pending>();
  private closedReason: string | undefined;

  constructor(
    private readonly writeLine: (line: string) => void,
    private readonly handlers: JsonRpcHandlers,
  ) {}

  get isClosed(): boolean {
    return this.closedReason !== undefined;
  }

  request<T>(method: string, params?: unknown, opts: { timeoutMs?: number } = {}): Promise<T> {
    if (this.closedReason !== undefined) {
      return Promise.reject(new ConnectionClosedError(this.closedReason));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const entry: Pending = { method, resolve: resolve as (v: unknown) => void, reject };
      if (opts.timeoutMs) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new RpcError(-32000, `${method} timed out after ${opts.timeoutMs} ms`));
        }, opts.timeoutMs);
      }
      this.pending.set(id, entry);
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closedReason === undefined) this.send({ jsonrpc: "2.0", method, params });
  }

  handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed);
    } catch (error) {
      this.handlers.onProtocolError?.(line, error);
      return;
    }
    if (typeof msg !== "object" || msg === null || msg.jsonrpc !== "2.0") {
      this.handlers.onProtocolError?.(line, new Error("not a JSON-RPC 2.0 message"));
      return;
    }

    const hasId = msg.id !== undefined && msg.id !== null;
    if (typeof msg.method === "string") {
      if (hasId) void this.answer(msg.id as Id, msg.method, msg.params);
      else this.dispatchNotification(msg.method, msg.params);
      return;
    }
    if (hasId) this.settle(msg.id as Id, msg);
  }

  /** Rejects everything in flight; later calls fail fast. */
  close(reason: string): void {
    if (this.closedReason !== undefined) return;
    this.closedReason = reason;
    for (const [id, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new ConnectionClosedError(`${p.method}: ${reason}`));
      this.pending.delete(id);
    }
  }

  private dispatchNotification(method: string, params: unknown): void {
    try {
      this.handlers.onNotification(method, params);
    } catch (error) {
      this.handlers.onProtocolError?.(`notification ${method}`, error);
    }
  }

  private async answer(id: Id, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.handlers.onRequest(method, params);
      this.send({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (error) {
      const rpc = error instanceof RpcError ? error : new RpcError(-32603, String((error as Error)?.message ?? error));
      this.send({ jsonrpc: "2.0", id, error: { code: rpc.code, message: rpc.message, data: rpc.data } });
    }
  }

  private settle(id: Id, msg: Record<string, unknown>): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    if (p.timer) clearTimeout(p.timer);
    const err = msg.error as { code?: number; message?: string; data?: unknown } | undefined;
    if (err) p.reject(new RpcError(err.code ?? -32603, `${p.method}: ${err.message ?? "unknown error"}`, err.data));
    else p.resolve(msg.result);
  }

  private send(msg: unknown): void {
    if (this.closedReason !== undefined) return;
    this.writeLine(JSON.stringify(msg));
  }
}
