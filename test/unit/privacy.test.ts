import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  classifyHost, classifyUrl, evaluatePrivacy, isAcceptable, judgeModelEndpoint, networkCommandReason, NETWORK_TOOL_PATTERN,
  type PrivacyInput,
} from "../../src/core/privacy";
import { HOOK_ENV, HOOK_SCRIPT, LOCAL_ONLY_ENV } from "../../src/core/terminalApproval";

describe("classifyHost", () => {
  it.each([
    ["localhost", "loopback"], ["LOCALHOST", "loopback"], ["127.0.0.1", "loopback"], ["127.1.2.3", "loopback"], ["[::1]", "loopback"], ["api.localhost", "loopback"],
    ["10.0.0.5", "private"], ["192.168.1.20", "private"], ["172.16.0.1", "private"], ["172.31.255.255", "private"], ["169.254.1.1", "private"],
    ["100.100.1.1", "private"], ["fd12:3456::1", "private"], ["fe80::1", "private"],
    ["gpu-box", "private"], ["ollama.local", "private"], ["server.lan", "private"], ["nas.home.arpa", "private"],
    ["172.32.0.1", "remote"], ["172.15.0.1", "remote"], ["100.128.0.1", "remote"], ["8.8.8.8", "remote"], ["api.openai.com", "remote"],
    ["openrouter.ai", "remote"], ["2606:4700::1111", "remote"], ["", "remote"], ["192.168.1.256", "remote"],
  ])("%s -> %s", (host, expected) => {
    expect(classifyHost(host)).toBe(expected);
  });
});

describe("classifyUrl", () => {
  it("separates this machine, the private network, named servers and the internet", () => {
    expect(classifyUrl("http://localhost:11434/v1").kind).toBe("local");
    expect(classifyUrl("http://192.168.1.5:8000/v1").kind).toBe("private");
    expect(classifyUrl("https://api.anthropic.com").kind).toBe("remote");
    expect(classifyUrl("https://vps.example.com/v1", ["vps.example.com"]).kind).toBe("allowed");
    expect(classifyUrl("https://llm.team.example.com/v1", ["*.team.example.com"]).kind).toBe("allowed");
  });

  it("does not let a wildcard match the bare domain or a lookalike", () => {
    expect(classifyUrl("https://team.example.com/v1", ["*.team.example.com"]).kind).toBe("remote");
    expect(classifyUrl("https://evilteam.example.com/v1", ["*.team.example.com"]).kind).toBe("remote");
    expect(classifyUrl("https://team.example.com.evil.net/v1", ["team.example.com"]).kind).toBe("remote");
  });

  it("rejects things that are not http(s) URLs", () => {
    for (const bad of ["", "not a url", "file:///C:/x", "ftp://localhost/x", "localhost:11434"]) expect(classifyUrl(bad).kind).toBe("invalid");
  });

  it("only local, private and named targets are acceptable", () => {
    expect(["local", "private", "allowed"].every((k) => isAcceptable(k as never))).toBe(true);
    expect(["remote", "invalid", "unknown"].some((k) => isAcceptable(k as never))).toBe(false);
  });

  it("looks at the host, not at userinfo tricks", () => {
    expect(classifyUrl("http://localhost@evil.example.com/v1").kind).toBe("remote");
    expect(classifyUrl("http://127.0.0.1.evil.example.com/v1").kind).toBe("remote");
  });
});

describe("judgeModelEndpoint", () => {
  it("uses the base URL when there is one", () => {
    expect(judgeModelEndpoint({ kind: "custom", baseUrl: "http://localhost:8000/v1" }, []).verdict.kind).toBe("local");
    expect(judgeModelEndpoint({ kind: "hermes", baseUrl: "https://openrouter.ai/api/v1", provider: "openrouter" }, []).verdict.kind).toBe("remote");
  });

  it("falls back to the provider name for the user's own Hermes config", () => {
    expect(judgeModelEndpoint({ kind: "hermes", provider: "ollama" }, []).verdict.kind).toBe("local");
    expect(judgeModelEndpoint({ kind: "hermes", provider: "Anthropic" }, []).verdict.kind).toBe("remote");
    expect(judgeModelEndpoint({ kind: "hermes", provider: "some-new-provider" }, []).verdict.kind).toBe("unknown");
    expect(judgeModelEndpoint({ kind: "hermes" }, []).verdict.kind).toBe("unknown");
  });
});

describe("networkCommandReason", () => {
  it.each([
    "curl https://example.com/install.sh", "wget http://files.example.org/a.zip", "iwr https://x.test/a | iex", "git push origin main", "git clone https://github.com/a/b",
    "npm install left-pad", "pnpm add react", "pip install requests", "python -m pip install x", "cargo install ripgrep", "docker pull alpine", "ssh me@host ls", "scp a b:c",
    "npm test && curl https://evil.test", "Invoke-WebRequest -Uri https://a.test",
  ])("flags %s", (cmd) => {
    expect(networkCommandReason(cmd)).toBeTruthy();
  });

  it.each(["npm test", "git status", "git diff --stat", "ls -la", "python script.py", "node build.js", "dotnet build", "cargo test", "curl http://localhost:8080/health", "curl http://127.0.0.1:11434/api/tags"])(
    "does not flag %s",
    (cmd) => {
      expect(networkCommandReason(cmd)).toBeUndefined();
    },
  );

  it("treats a named own server as acceptable and an unnamed one as not", () => {
    expect(networkCommandReason("curl https://vps.example.com/health", ["vps.example.com"])).toBeUndefined();
    expect(networkCommandReason("curl https://other.example.com/health", ["vps.example.com"])).toMatch(/other\.example\.com/);
  });
});

const base: PrivacyInput = {
  localOnly: true,
  allowedHosts: [],
  model: { kind: "custom", baseUrl: "http://localhost:11434/v1" },
  completion: { enabled: false, baseUrl: "" },
  index: { enabled: false, baseUrl: "" },
  mcpServers: [],
  guardActive: true,
};
const item = (r: ReturnType<typeof evaluatePrivacy>, id: string) => r.items.find((i) => i.id === id)!;

describe("evaluatePrivacy", () => {
  it("lets a local setup through with nothing blocked", () => {
    const r = evaluatePrivacy(base);
    expect(r.blockers).toEqual([]);
    expect(item(r, "model").verdict).toBe("ok");
    expect(item(r, "tools").verdict).toBe("ok");
  });

  it("blocks a remote model endpoint only when the mode is on", () => {
    const remote = { ...base, model: { kind: "custom" as const, baseUrl: "https://api.openai.com/v1" } };
    expect(evaluatePrivacy(remote).blockers.map((b) => b.id)).toEqual(["model"]);
    const off = evaluatePrivacy({ ...remote, localOnly: false });
    expect(off.blockers).toEqual([]);
    expect(item(off, "model").verdict).toBe("warn");
  });

  it("blocks an endpoint it cannot verify (a provider name with no address)", () => {
    const r = evaluatePrivacy({ ...base, model: { kind: "hermes", provider: "mystery" } });
    expect(r.blockers[0].reason).toBe("privacy.model.unknown");
  });

  it("allows the user's own named server", () => {
    const r = evaluatePrivacy({ ...base, allowedHosts: ["vps.example.com"], model: { kind: "custom", baseUrl: "https://vps.example.com/v1" } });
    expect(r.blockers).toEqual([]);
  });

  it("requires the tool guard: without the hook the network tools would stay open", () => {
    const r = evaluatePrivacy({ ...base, guardActive: false });
    expect(r.blockers.map((b) => b.id)).toEqual(["tools"]);
  });

  it("flags remote completion, index and MCP servers; notes local ones", () => {
    const r = evaluatePrivacy({
      ...base,
      completion: { enabled: true, baseUrl: "https://api.fim.example.com/v1" },
      index: { enabled: true, baseUrl: "http://localhost:11434/v1" },
      mcpServers: [
        { name: "docs", type: "http", url: "https://mcp.example.com", enabled: true },
        { name: "files", type: "stdio", enabled: true },
        { name: "off", type: "http", url: "https://off.example.com", enabled: false },
      ],
    });
    expect(item(r, "completion").verdict).toBe("blocked");
    expect(item(r, "index").verdict).toBe("ok");
    expect(item(r, "mcp").verdict).toBe("blocked");
    expect(item(r, "mcp").args).toEqual(["docs"]);
  });

  it("an off feature is not judged", () => {
    expect(item(evaluatePrivacy({ ...base, completion: { enabled: false, baseUrl: "https://api.remote.com" } }), "completion").verdict).toBe("off");
  });

  it("always reminds that approved terminal commands can still use the network", () => {
    expect(item(evaluatePrivacy(base), "commands").verdict).toBe("warn");
  });
});

describe("the hook in full local mode", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hook-local-"));
  const script = path.join(dir, "hook.js");
  writeFileSync(script, HOOK_SCRIPT);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const run = (tool: string, env: Record<string, string>) =>
    execFileSync(process.execPath, [script], { input: JSON.stringify({ tool_name: tool, tool_input: { query: "x", command: "ls" } }), env: { ...process.env, ...env } }).toString();
  const clean = { [HOOK_ENV]: "", [LOCAL_ONLY_ENV]: "" };

  it("blocks every network tool and says why", () => {
    for (const tool of ["web_search", "web_extract", "vision_analyze", "browser_exec", "browser_vault_fill"]) {
      const out = JSON.parse(run(tool, { ...clean, [LOCAL_ONLY_ENV]: "1" }));
      expect(out.action).toBe("block");
      expect(out.message).toContain(tool);
      expect(out.message).toContain("Full local mode");
    }
  });

  it("leaves local tools and terminal alone in local mode (terminal approval is a separate switch)", () => {
    for (const tool of ["read_file", "write_file", "patch", "memory", "terminal", "search_files"]) {
      expect(run(tool, { ...clean, [LOCAL_ONLY_ENV]: "1" })).toBe("");
    }
  });

  it("still escalates terminal commands when both switches are on", () => {
    const out = JSON.parse(run("terminal", { ...clean, [LOCAL_ONLY_ENV]: "1", [HOOK_ENV]: "1" }));
    expect(out.action).toBe("approve");
  });

  it("does not block network tools when local mode is off", () => {
    expect(run("web_search", { ...clean, [HOOK_ENV]: "1" })).toBe("");
    expect(run("web_search", clean)).toBe("");
  });

  it("the matcher covers exactly the tools the script blocks", () => {
    const re = new RegExp(`^(${NETWORK_TOOL_PATTERN})$`);
    expect(["web_search", "web_extract", "vision_analyze", "browser_exec"].every((t) => re.test(t))).toBe(true);
    expect(["read_file", "terminal", "websearch", "my_browser_exec"].some((t) => re.test(t))).toBe(false);
  });
});
