// Tiny MCP server over stdio (newline-delimited JSON-RPC) with one tool, `echo`.
import readline from "node:readline";

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined) return; // notifications
  switch (msg.method) {
    case "initialize":
      return send({
        id: msg.id,
        result: {
          protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "echo", version: "1.0.0" },
        },
      });
    case "tools/list":
      return send({
        id: msg.id,
        result: {
          tools: [{
            name: "echo",
            description: "Echo the given text back (Hermes IDE test server).",
            inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
          }],
        },
      });
    case "tools/call":
      return send({ id: msg.id, result: { content: [{ type: "text", text: `echo: ${msg.params?.arguments?.text ?? ""}` }] } });
    case "ping":
      return send({ id: msg.id, result: {} });
    default:
      return send({ id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } });
  }
});
