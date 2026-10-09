// Minimal OpenAI-compatible server for tests: scripted chat completions (text or tool calls),
// /models listing, optional bearer auth, and a request log for assertions.
//
// Usage (CLI): node test/fixtures/openai-mock.mjs [port]
// Usage (tests): const mock = await startOpenAIMock({ apiKey, models }); mock.script([...]); await mock.close();
import http from "node:http";

/**
 * @typedef {{ text?: string, toolCalls?: { name: string, arguments: object }[], delayMs?: number, rejectTools?: boolean }} ScriptedReply
 */

export async function startOpenAIMock({ port = 0, apiKey, models = [{ id: "mock-model", context_length: 128000 }] } = {}) {
  /** @type {ScriptedReply[]} */
  const queue = [];
  /** @type {{ method: string, path: string, auth?: string, body?: any }[]} */
  const requests = [];
  let defaultReply = { text: "OK" };
  const auxReply = "Mock title";
  let callSeq = 0;

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body;
    try { body = raw ? JSON.parse(raw) : undefined; } catch { body = raw; }
    const path = (req.url ?? "").replace(/\?.*$/, "");
    if (!path.startsWith("/__")) requests.push({ method: req.method ?? "", path, auth: req.headers.authorization, body });

    // Control endpoints so a test running in another process (the VS Code extension host) can
    // script replies and inspect what Hermes sent.
    if (path === "/__script" && req.method === "POST") {
      queue.push(...(Array.isArray(body) ? body : [body]));
      return json(res, 200, { queued: queue.length });
    }
    if (path === "/__requests" && req.method === "GET") {
      return json(res, 200, requests.filter((r) => r.path.endsWith("/chat/completions")).map((r) => r.body));
    }
    if (apiKey && req.headers.authorization !== `Bearer ${apiKey}`) {
      return json(res, 401, { error: { message: "Invalid API key", type: "invalid_request_error", code: "invalid_api_key" } });
    }
    if (req.method === "GET" && path === "/v1/models") {
      return json(res, 200, { object: "list", data: models.map((m) => ({ object: "model", owned_by: "mock", ...m })) });
    }
    if (req.method === "POST" && path === "/v1/chat/completions") {
      if (models.length && body?.model && !models.some((m) => m.id === body.model)) {
        return json(res, 404, { error: { message: `The model '${body.model}' does not exist`, code: "model_not_found" } });
      }
      // Hermes also calls the model for auxiliary work (session titles) without tools; those must
      // not consume the replies scripted for the agent loop.
      const isAgentTurn = Array.isArray(body?.tools) && body.tools.length > 0;
      const reply = isAgentTurn && queue.length ? queue.shift() : isAgentTurn ? defaultReply : { text: auxReply };
      if (reply.rejectTools && body?.tools) {
        return json(res, 400, { error: { message: "This model does not support tools", code: "tools_unsupported" } });
      }
      if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
      if (res.destroyed) return;
      return body?.stream ? streamReply(res, body, reply) : json(res, 200, completion(body, reply));
    }
    json(res, 404, { error: { message: `no route ${req.method} ${path}` } });
  });

  function completion(body, reply) {
    const toolCalls = (reply.toolCalls ?? []).map((t) => ({
      id: `call_${++callSeq}`, type: "function", function: { name: t.name, arguments: JSON.stringify(t.arguments) },
    }));
    return {
      id: `chatcmpl-mock-${callSeq}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: body?.model,
      choices: [{
        index: 0,
        message: { role: "assistant", content: reply.text ?? null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
        finish_reason: toolCalls.length ? "tool_calls" : "stop",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    };
  }

  function streamReply(res, body, reply) {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const id = `chatcmpl-mock-${++callSeq}`;
    const base = { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body?.model };
    const send = (delta, finish = null, extra = {}) =>
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`);
    send({ role: "assistant", content: "" });
    if (reply.text) {
      for (const piece of reply.text.match(/.{1,8}/gs) ?? []) send({ content: piece });
    }
    const calls = reply.toolCalls ?? [];
    calls.forEach((t, index) => {
      send({ tool_calls: [{ index, id: `call_${++callSeq}`, type: "function", function: { name: t.name, arguments: "" } }] });
      send({ tool_calls: [{ index, function: { arguments: JSON.stringify(t.arguments) } }] });
    });
    send({}, calls.length ? "tool_calls" : "stop");
    if (body?.stream_options?.include_usage) {
      res.write(`data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`);
    }
    res.end("data: [DONE]\n\n");
  }

  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const actualPort = /** @type {import("node:net").AddressInfo} */ (server.address()).port;

  return {
    port: actualPort,
    baseUrl: `http://127.0.0.1:${actualPort}/v1`,
    requests,
    /** Queue replies consumed in order by chat completion calls. */
    script(replies) { queue.push(...replies); },
    setDefault(reply) { defaultReply = reply; },
    chatRequests() { return requests.filter((r) => r.path.endsWith("/chat/completions")); },
    close() { return new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }); },
  };
}

function json(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("openai-mock.mjs")) {
  const mock = await startOpenAIMock({ port: Number(process.argv[2] ?? 0), apiKey: process.env.MOCK_KEY });
  console.log(`openai-mock listening on ${mock.baseUrl}`);
}
