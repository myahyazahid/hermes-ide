import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chunkText, CHUNK_LINES, CHUNK_MAX_CHARS, CHUNK_OVERLAP, embeddingInput, shouldIndex } from "../../src/core/chunker";
import { EMBED_BATCH, embed, normalize } from "../../src/core/embeddings";
import { buildFimRequest, cleanCompletion, contextWindow, requestFim, resolveTemplate, wantsMultiline } from "../../src/core/fim";
import { McpHttpServer } from "../../src/core/mcpHttpServer";
import { VectorStore } from "../../src/core/vectorStore";
import { startOpenAIMock, type OpenAIMock } from "../fixtures/openai-mock.mjs";

const ep = (template: "auto" | "suffix" | "qwen" | "starcoder" | "codellama" | "deepseek", model = "m") =>
  ({ baseUrl: "http://x/v1/", model, template, maxTokens: 96 });

describe("FIM prompts (F-17)", () => {
  it("picks the template from the model name", () => {
    expect(resolveTemplate("auto", "qwen2.5-coder:1.5b")).toBe("qwen");
    expect(resolveTemplate("auto", "bigcode/starcoder2-3b")).toBe("starcoder");
    expect(resolveTemplate("auto", "codellama:7b-code")).toBe("codellama");
    expect(resolveTemplate("auto", "deepseek-coder-v2-lite")).toBe("deepseek");
    expect(resolveTemplate("auto", "codestral-latest")).toBe("suffix");
    expect(resolveTemplate("starcoder", "qwen2.5-coder")).toBe("starcoder");
  });

  it("builds family-specific prompts and server-side suffix requests", () => {
    const q = buildFimRequest(ep("auto", "qwen2.5-coder:7b"), "a(", ")", false);
    expect(q.url).toBe("http://x/v1/completions");
    expect(q.body.prompt).toBe("<|fim_prefix|>a(<|fim_suffix|>)<|fim_middle|>");
    expect((q.body.stop as string[]).length).toBeLessThanOrEqual(4);
    expect(q.body.max_tokens).toBe(48);
    const s = buildFimRequest(ep("suffix"), "a(", ")", true);
    expect(s.body).toMatchObject({ prompt: "a(", suffix: ")", max_tokens: 96 });
    expect(buildFimRequest(ep("codellama"), "p", "s", false).body.prompt).toBe("<PRE> p <SUF>s <MID>");
    expect(buildFimRequest(ep("deepseek"), "p", "s", false).body.prompt).toBe("<｜fim▁begin｜>p<｜fim▁hole｜>s<｜fim▁end｜>");
  });

  it("cleans completions", () => {
    const stops = ["<|endoftext|>"];
    expect(cleanCompletion("a + b;<|endoftext|>junk", { suffix: "\n}", stops, multiline: false })).toBe("a + b;");
    expect(cleanCompletion("a, b)", { suffix: ")\n", stops, multiline: false })).toBe("a, b");
    expect(cleanCompletion("first\nsecond", { suffix: "", stops, multiline: false })).toBe("first");
    expect(cleanCompletion("  x = 1;\n  y = 2;\n\n", { suffix: "", stops, multiline: true })).toBe("  x = 1;\n  y = 2;");
    expect(cleanCompletion("}", { suffix: "\n}", stops, multiline: false })).toBe("");
  });

  it("windows context at line boundaries and decides when to go multi-line", () => {
    const text = "line1\nline2\nline3\nline4";
    const offset = text.indexOf("line3") + 2;
    expect(contextWindow(text, offset, 8, 100)).toEqual({ prefix: "li", suffix: "ne3\nline4" });
    expect(wantsMultiline("function f() {", "\n}")).toBe(true);
    expect(wantsMultiline("  const x = ", "\n")).toBe(false);
    expect(wantsMultiline("  foo(", "bar)")).toBe(false);
    expect(wantsMultiline("  ", "\n")).toBe(true);
  });
});

describe("network clients", () => {
  let mock: OpenAIMock;
  beforeAll(async () => {
    mock = await startOpenAIMock({ apiKey: "sk-x" });
  });
  afterAll(() => mock.close());

  it("requests a FIM completion with the key and reports latency", async () => {
    mock.scriptFim([{ text: "a + b;<|endoftext|>" }]);
    const r = await requestFim({ ...ep("qwen"), baseUrl: mock.baseUrl, apiKey: "sk-x" }, "return ", "\n}", { multiline: false });
    expect(r.text).toBe("a + b;");
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    expect(mock.fimRequests().at(-1)?.auth).toBe("Bearer sk-x");
  });

  it("surfaces HTTP errors and honours cancellation", async () => {
    await expect(requestFim({ ...ep("qwen"), baseUrl: mock.baseUrl, apiKey: "wrong" }, "a", "b", { multiline: false })).rejects.toThrow(/401/);
    mock.scriptFim([{ text: "slow", delayMs: 2000 }]);
    const controller = new AbortController();
    const pending = requestFim({ ...ep("qwen"), baseUrl: mock.baseUrl, apiKey: "sk-x" }, "a", "b", { multiline: false, signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toThrow();
  });

  it("embeds in batches and normalises vectors", async () => {
    const inputs = Array.from({ length: EMBED_BATCH + 5 }, (_, i) => `function number${i} returns value`);
    const vectors = await embed({ baseUrl: mock.baseUrl, model: "e", apiKey: "sk-x" }, inputs);
    expect(vectors).toHaveLength(inputs.length);
    const norm = Math.sqrt(vectors[0].reduce((a, x) => a + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
    expect(mock.requests.filter((r) => r.path === "/v1/embeddings").length).toBe(2);
  });
});

describe("chunker (F-18)", () => {
  it("splits into overlapping windows that cover the file", () => {
    const lines = Array.from({ length: 130 }, (_, i) => `line ${i + 1}`);
    const chunks = chunkText(lines.join("\n"));
    expect(chunks[0]).toMatchObject({ startLine: 1, endLine: CHUNK_LINES });
    expect(chunks[1].startLine).toBe(CHUNK_LINES - CHUNK_OVERLAP + 1);
    expect(chunks.at(-1)!.endLine).toBe(130);
  });

  it("keeps chunks under the character cap and skips binaries/minified files", () => {
    const wide = Array.from({ length: 60 }, () => "x".repeat(200)).join("\n");
    expect(chunkText(wide).every((c) => c.text.length <= CHUNK_MAX_CHARS)).toBe(true);
    expect(chunkText("a\0b")).toEqual([]);
    expect(chunkText("x".repeat(5000))).toEqual([]);
    expect(shouldIndex("src/a.ts", 100, 1000)).toBe(true);
    expect(shouldIndex("package-lock.json", 100, 1000)).toBe(false);
    expect(shouldIndex("dist/app.min.js", 100, 1000)).toBe(false);
    expect(shouldIndex("big.ts", 2000, 1000)).toBe(false);
    expect(embeddingInput("src/a.ts", { startLine: 1, endLine: 2, text: "x" })).toBe("File: src/a.ts (lines 1-2)\nx");
  });
});

describe("vector store (F-18)", () => {
  const v = (...xs: number[]) => normalize(Float32Array.from(xs));

  it("ranks by cosine, limits hits per file, and replaces/removes files", () => {
    const store = new VectorStore("e");
    store.setFile("a.ts", "1:1", [{ startLine: 1, endLine: 5, text: "a1" }, { startLine: 6, endLine: 9, text: "a2" }], [v(1, 0), v(0.9, 0.1)]);
    store.setFile("b.ts", "1:1", [{ startLine: 1, endLine: 3, text: "b1" }], [v(0, 1)]);
    expect(store.search(v(1, 0), 3).map((h) => h.text)).toEqual(["a1", "a2", "b1"]);
    expect(store.search(v(1, 0), 3, 1).map((h) => h.text)).toEqual(["a1", "b1"]);
    store.setFile("a.ts", "2:2", [{ startLine: 1, endLine: 2, text: "a-new" }], [v(1, 0)]);
    expect(store.size).toBe(2);
    store.removeFile("b.ts");
    expect(store.paths()).toEqual(["a.ts"]);
    expect(() => store.setFile("c.ts", "x", [{ startLine: 1, endLine: 1, text: "c" }], [v(1, 0, 0)])).toThrow(/size changed/);
  });

  it("round-trips through serialisation and rejects another model's data", () => {
    const store = new VectorStore("e");
    store.setFile("a.ts", "1:1", [{ startLine: 1, endLine: 5, text: "hello" }], [v(0.6, 0.8)]);
    const { meta, vectors } = store.serialize();
    const back = VectorStore.deserialize(meta, vectors, "e")!;
    expect(back.fingerprint("a.ts")).toBe("1:1");
    expect(back.search(v(0.6, 0.8), 1)[0].score).toBeCloseTo(1, 5);
    expect(VectorStore.deserialize(meta, vectors, "other")).toBeUndefined();
    expect(VectorStore.deserialize(meta, vectors.subarray(1), "e")).toBeUndefined();
  });
});

describe("IDE MCP server", () => {
  const server = new McpHttpServer(
    () => [{ name: "echo", description: "d", inputSchema: { type: "object" }, call: async (a) => ({ text: `got ${a.x}` }) }],
    { name: "hermes-ide", version: "1" },
  );
  let url: string;
  const j = async (r: Response): Promise<any> => r.json();
  const call = (body: unknown, token = server.token) =>
    fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  beforeAll(async () => {
    url = await server.start();
  });
  afterAll(() => server.close());

  it("speaks initialize, tools/list and tools/call, and acknowledges notifications", async () => {
    const init = await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
    expect(init.headers.get("mcp-session-id")).toBeTruthy();
    expect((await j(init)).result).toMatchObject({ protocolVersion: "2025-03-26", serverInfo: { name: "hermes-ide" } });
    expect((await call({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    expect((await j(await call({ jsonrpc: "2.0", id: 2, method: "tools/list" }))).result.tools[0].name).toBe("echo");
    const r = await j(await call({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo", arguments: { x: 7 } } }));
    expect(r.result).toEqual({ content: [{ type: "text", text: "got 7" }], isError: false });
    expect((await j(await call({ jsonrpc: "2.0", id: 4, method: "nope" }))).error.code).toBe(-32601);
  });

  it("only listens on loopback and requires the token", async () => {
    expect(url.startsWith("http://127.0.0.1:")).toBe(true);
    expect((await call({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "bad")).status).toBe(401);
    expect((await fetch(url)).status).toBe(401);
  });
});
