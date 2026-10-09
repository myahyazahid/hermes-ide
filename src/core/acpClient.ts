// ACP client for `hermes acp`: owns the child process, speaks JSON-RPC over stdio, and exposes
// the handful of agent methods Hermes IDE needs. This is the adapter layer the PRD asks for, so a
// change in Hermes' ACP surface stays contained here.
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import type * as acp from "@agentclientprotocol/sdk";
import { JsonRpcPeer, RpcError } from "./jsonrpc";
import { needsShell } from "./hermesLocator";

export const ACP_PROTOCOL_VERSION = 1;

export interface HermesLaunch {
  command: string;
  args?: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface AcpClientHandlers {
  onSessionUpdate(notification: acp.SessionNotification): void;
  onPermission(request: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse>;
  /** Hermes logs to stderr; stdout is reserved for ACP. */
  onLog(line: string): void;
  /** `expected` is true when the exit was requested through stop(). */
  onExit(info: { code: number | null; signal: NodeJS.Signals | null; expected: boolean }): void;
}

/** Hermes still sends the (unstable) model picker state that SDK 1.7 dropped from the schema. */
export interface HermesModelState {
  availableModels: { modelId: string; name: string; description?: string | null }[];
  currentModelId: string;
}

export type HermesSessionResponse = acp.NewSessionResponse & { models?: HermesModelState | null };
export type HermesLoadResponse = acp.LoadSessionResponse & { models?: HermesModelState | null };

export interface ClientInfo {
  name: string;
  version: string;
}

export class AcpClient {
  private stopping = false;
  private exited = false;
  private readonly exitPromise: Promise<void>;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly peer: JsonRpcPeer,
    public init: acp.InitializeResponse | undefined = undefined,
  ) {
    this.exitPromise = new Promise((resolve) => child.once("exit", () => resolve()));
  }

  /** Spawns `hermes acp` and performs the ACP initialize handshake. */
  static async start(launch: HermesLaunch, handlers: AcpClientHandlers, clientInfo: ClientInfo): Promise<AcpClient> {
    const shell = needsShell(launch.command);
    const child = spawn(shell ? `"${launch.command}"` : launch.command, launch.args ?? ["acp"], {
      cwd: launch.cwd,
      env: launch.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell,
    });

    const peer = new JsonRpcPeer((line) => child.stdin.write(line + "\n"), {
      onRequest: (method, params) => AcpClient.handleAgentRequest(handlers, method, params),
      onNotification: (method, params) => {
        if (method === "session/update") handlers.onSessionUpdate(params as acp.SessionNotification);
      },
      onProtocolError: (line, error) => handlers.onLog(`[acp] ignored non-protocol stdout: ${line.slice(0, 200)} (${error})`),
    });
    const client = new AcpClient(child, peer);

    readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (l) => peer.handleLine(l));
    readline.createInterface({ input: child.stderr, crlfDelay: Infinity }).on("line", (l) => handlers.onLog(l));
    child.stdin.on("error", (e) => handlers.onLog(`[acp] stdin error: ${e.message}`));

    const spawnFailure = new Promise<never>((_, reject) => {
      child.once("error", (e) => {
        peer.close(`failed to start hermes: ${e.message}`);
        reject(e);
      });
    });
    child.once("exit", (code, signal) => {
      client.exited = true;
      peer.close(`hermes exited (code ${code ?? "?"}${signal ? `, ${signal}` : ""})`);
      handlers.onExit({ code, signal, expected: client.stopping });
    });

    try {
      client.init = await Promise.race([
        peer.request<acp.InitializeResponse>(
          "initialize",
          {
            protocolVersion: ACP_PROTOCOL_VERSION,
            // Hermes executes tools itself; it never calls client fs/terminal methods.
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
            clientInfo,
          } satisfies acp.InitializeRequest,
          { timeoutMs: 60_000 },
        ),
        spawnFailure,
      ]);
    } catch (error) {
      await client.stop();
      throw error;
    }
    return client;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get isAlive(): boolean {
    return !this.exited && !this.peer.isClosed;
  }

  authenticate(methodId: string): Promise<acp.AuthenticateResponse> {
    return this.peer.request("authenticate", { methodId } satisfies acp.AuthenticateRequest, { timeoutMs: 30_000 });
  }

  newSession(cwd: string, mcpServers: acp.McpServer[] = []): Promise<HermesSessionResponse> {
    return this.peer.request("session/new", { cwd, mcpServers } satisfies acp.NewSessionRequest, { timeoutMs: 120_000 });
  }

  /**
   * Re-attaches to a persisted session; Hermes replays its history first. Null when unknown.
   * Hermes never persists a session that has not been prompted yet, and answers a load for an
   * unknown id with an empty result rather than null; a real load always carries modes/models.
   */
  async loadSession(cwd: string, sessionId: string, mcpServers: acp.McpServer[] = []): Promise<HermesLoadResponse | null> {
    const res = await this.peer.request<HermesLoadResponse | null>(
      "session/load", { cwd, sessionId, mcpServers } satisfies acp.LoadSessionRequest, { timeoutMs: 120_000 },
    );
    return res && (res.modes || res.models) ? res : null;
  }

  /** Sessions for a working directory, newest first (all pages). */
  async listSessions(cwd: string): Promise<acp.SessionInfo[]> {
    const out: acp.SessionInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const res = await this.peer.request<acp.ListSessionsResponse>(
        "session/list", { cwd, ...(cursor ? { cursor } : {}) } satisfies acp.ListSessionsRequest, { timeoutMs: 30_000 },
      );
      out.push(...res.sessions);
      if (!res.nextCursor) break;
      cursor = res.nextCursor;
    }
    return out;
  }

  /** Hermes implements the (unstable) session/set_model with `provider:model` ids. */
  setModel(sessionId: string, modelId: string): Promise<unknown> {
    return this.peer.request("session/set_model", { sessionId, modelId }, { timeoutMs: 120_000 });
  }

  setMode(sessionId: string, modeId: string): Promise<acp.SetSessionModeResponse> {
    return this.peer.request("session/set_mode", { sessionId, modeId } satisfies acp.SetSessionModeRequest);
  }

  prompt(sessionId: string, prompt: acp.ContentBlock[]): Promise<acp.PromptResponse> {
    return this.peer.request("session/prompt", { sessionId, prompt } satisfies acp.PromptRequest);
  }

  cancel(sessionId: string): void {
    this.peer.notify("session/cancel", { sessionId } satisfies acp.CancelNotification);
  }

  /** Closes stdin so Hermes can exit on its own, then force-kills the whole process tree. */
  async stop(graceMs = 1500): Promise<void> {
    if (this.exited) return;
    this.stopping = true;
    this.peer.close("client stopped");
    try {
      this.child.stdin.end();
    } catch {
      // already closed
    }
    const exitedInTime = await Promise.race([
      this.exitPromise.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), graceMs)),
    ]);
    if (!exitedInTime) await killTree(this.child);
  }

  private static async handleAgentRequest(handlers: AcpClientHandlers, method: string, params: unknown): Promise<unknown> {
    if (method === "session/request_permission") {
      return handlers.onPermission(params as acp.RequestPermissionRequest);
    }
    // We advertise no fs/terminal capabilities, so anything else is unexpected.
    throw RpcError.methodNotFound(method);
  }
}

/** hermes.exe is a launcher with a Python child; killing only the parent would orphan it. */
function killTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve) => {
    if (child.pid === undefined) return resolve();
    if (process.platform === "win32") {
      execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => resolve());
    } else {
      child.kill("SIGKILL");
      resolve();
    }
  });
}
