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
  /** FIM replies for /completions: { text, delayMs? }; default echoes a marker. */
  const fimQueue = [];
  const auxReply = "Mock title";
  /** model id -> HTTP status to answer chat requests with (see /__fail). */
  const failModels = new Map();
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
    if (path === "/__fail" && req.method === "POST") {
      for (const [model, status] of Object.entries(body ?? {})) {
        if (status) failModels.set(model, Number(status));
        else failModels.delete(model);
      }
      return json(res, 200, { failing: [...failModels.keys()] });
    }
    if (path === "/__fim" && req.method === "POST") {
      fimQueue.push(...(Array.isArray(body) ? body : [body]));
      return json(res, 200, { queued: fimQueue.length });
    }
    if (path === "/__requests" && req.method === "GET") {
      const wanted = new URL(req.url ?? "", "http://x").searchParams.get("path") ?? "/v1/chat/completions";
      return json(res, 200, requests.filter((r) => r.path === wanted).map((r) => r.body));
    }
    if (apiKey && req.headers.authorization !== `Bearer ${apiKey}`) {
      return json(res, 401, { error: { message: "Invalid API key", type: "invalid_request_error", code: "invalid_api_key" } });
    }
    if (req.method === "GET" && path === "/v1/models") {
      return json(res, 200, { object: "list", data: models.map((m) => ({ object: "model", owned_by: "mock", ...m })) });
    }
    if (req.method === "POST" && path === "/v1/completions") {
      const reply = fimQueue.length ? fimQueue.shift() : { text: "completion()" };
      if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
      if (res.destroyed) return;
      return json(res, 200, {
        id: `cmpl-mock-${++callSeq}`, object: "text_completion", model: body?.model,
        choices: [{ index: 0, text: reply.text, finish_reason: "stop" }],
      });
    }
    if (req.method === "POST" && path === "/v1/embeddings") {
      const inputs = Array.isArray(body?.input) ? body.input : [body?.input ?? ""];
      return json(res, 200, { object: "list", model: body?.model, data: inputs.map((t, index) => ({ object: "embedding", index, embedding: bagOfWords(String(t)) })) });
    }
    if (req.method === "POST" && path === "/v1/chat/completions") {
      if (models.length && body?.model && !models.some((m) => m.id === body.model)) {
        return json(res, 404, { error: { message: `The model '${body.model}' does not exist`, code: "model_not_found" } });
      }
      if (failModels.has(body?.model)) {
        return json(res, failModels.get(body.model), { error: { message: `forced failure for ${body.model}`, code: "forced_failure" } });
      }
      // Hermes also calls the model for auxiliary work (session titles) without tools; those must
      // not consume the replies scripted for the agent loop.
      // Hermes' background memory review also runs with tools; it is not an agent turn either.
      const lastUser = [...(body?.messages ?? [])].reverse().find((x) => x.role === "user")?.content;
      const isBackgroundReview = typeof lastUser === "string" && lastUser.startsWith("Review the conversation above");
      const isAgentTurn = Array.isArray(body?.tools) && body.tools.length > 0 && !isBackgroundReview;
      // A scripted reply may carry `when`: it then goes to the agent whose user message contains that text, which keeps
      // several agents running at once (parallel tasks) from taking each other's replies.
      let scripted;
      if (isAgentTurn) {
        const i = queue.findIndex((r) => !r.when || (typeof lastUser === "string" && lastUser.includes(r.when)));
        if (i >= 0) scripted = queue.splice(i, 1)[0];
      }
      const reply = scripted ?? (isAgentTurn ? defaultReply : { text: auxReply });
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
    scriptFim(replies) { fimQueue.push(...replies); },
    fimRequests() { return requests.filter((r) => r.path === "/v1/completions"); },
    setDefault(reply) { defaultReply = reply; },
    /** Answer chat requests for `model` with HTTP `status` (0 clears it). */
    failModel(model, status) { if (status) failModels.set(model, status); else failModels.delete(model); },
    chatRequests() { return requests.filter((r) => r.path.endsWith("/chat/completions")); },
    close() { return new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }); },
  };
}

/** Deterministic "embedding": hashed bag of words, so texts sharing words are similar. */
export function bagOfWords(text, dims = 128) {
  const v = new Array(dims).fill(0);
  for (const w of text.toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length > 2)) {
    let h = 2166136261;
    for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w.charCodeAt(i), 16777619);
    v[(h >>> 0) % dims] += 1;
  }
  return v;
}

function json(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("openai-mock.mjs")) {
  const mock = await startOpenAIMock({ port: Number(process.argv[2] ?? 0), apiKey: process.env.MOCK_KEY });
  console.log(`openai-mock listening on ${mock.baseUrl}`);
}
