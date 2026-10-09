import { describe, expect, it, vi } from "vitest";
import { ConnectionClosedError, JsonRpcPeer, RpcError } from "../../src/core/jsonrpc";

function pair(
  onRequest: (method: string, params: unknown) => Promise<unknown> = vi.fn(async () => ({})),
  onNotification = vi.fn(),
) {
  const sent: any[] = [];
  const onProtocolError = vi.fn();
  const peer = new JsonRpcPeer((line) => sent.push(JSON.parse(line)), { onRequest, onNotification, onProtocolError });
  return { peer, sent, onRequest, onNotification, onProtocolError };
}

describe("JsonRpcPeer", () => {
  it("correlates responses with requests", async () => {
    const { peer, sent } = pair();
    const p = peer.request<{ ok: boolean }>("initialize", { a: 1 });
    expect(sent[0]).toMatchObject({ jsonrpc: "2.0", id: 1, method: "initialize", params: { a: 1 } });
    peer.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }));
    await expect(p).resolves.toEqual({ ok: true });
  });

  it("turns error responses into RpcError with the method name", async () => {
    const { peer } = pair();
    const p = peer.request("session/set_model");
    peer.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "bad model" } }));
    await expect(p).rejects.toMatchObject({ code: -32602, message: "session/set_model: bad model" });
  });

  it("answers incoming requests and reports handler errors", async () => {
    const onRequest = vi.fn(async (method: string) => {
      if (method === "fs/read_text_file") throw RpcError.methodNotFound(method);
      return { outcome: { outcome: "cancelled" } };
    });
    const { peer, sent } = pair(onRequest);
    peer.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "session/request_permission", params: {} }));
    peer.handleLine(JSON.stringify({ jsonrpc: "2.0", id: "x", method: "fs/read_text_file", params: {} }));
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[0]).toEqual({ jsonrpc: "2.0", id: 7, result: { outcome: { outcome: "cancelled" } } });
    expect(sent[1]).toMatchObject({ id: "x", error: { code: -32601 } });
  });

  it("dispatches notifications without replying", () => {
    const { peer, sent, onNotification } = pair();
    peer.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { x: 1 } }));
    expect(onNotification).toHaveBeenCalledWith("session/update", { x: 1 });
    expect(sent).toHaveLength(0);
  });

  it("reports non-JSON stdout instead of throwing", () => {
    const { peer, onProtocolError } = pair();
    peer.handleLine("Traceback (most recent call last):");
    peer.handleLine("   ");
    expect(onProtocolError).toHaveBeenCalledTimes(1);
  });

  it("rejects in-flight and future requests once closed", async () => {
    const { peer } = pair();
    const p = peer.request("session/prompt");
    peer.close("hermes exited");
    await expect(p).rejects.toBeInstanceOf(ConnectionClosedError);
    await expect(peer.request("x")).rejects.toBeInstanceOf(ConnectionClosedError);
    expect(peer.isClosed).toBe(true);
  });

  it("times out requests that never get an answer", async () => {
    vi.useFakeTimers();
    const { peer } = pair();
    const p = peer.request("initialize", {}, { timeoutMs: 1000 });
    vi.advanceTimersByTime(1001);
    await expect(p).rejects.toThrow(/timed out/);
    vi.useRealTimers();
  });
});
