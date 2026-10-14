// Full local mode (phase 6): keep code and prompts on this computer or on servers the user named. This file is the
// policy only: where an address points, which Hermes tools reach the network, and what a given configuration allows.
// It claims no more than it can enforce; see the README for what stays outside its reach (terminal commands the user
// approves, for example, can still use the network).
import { parseDocument } from "yaml";
import type { StringKey } from "../shared/strings";

export type HostKind = "loopback" | "private" | "remote";
export type TargetKind = "local" | "private" | "allowed" | "remote" | "invalid" | "unknown";

/** Tool names Hermes sends to the model that talk to something outside the machine (see the ACP toolset). */
export const NETWORK_TOOLS = ["web_search", "web_extract", "vision_analyze"] as const;
/** Every browser_* tool (exec and the vault family) drives a real browser. */
export const NETWORK_TOOL_PATTERN = "web_search|web_extract|vision_analyze|browser_.*";

/** The host part of a "custom:<host>:<model>" id: an IPv4 address, localhost, or a name ending in an alphabetic TLD. */
const CUSTOM_ID_HOST = /^custom:((?:\d{1,3}\.){3}\d{1,3}|localhost|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}):/i;

/** Providers that only ever mean a cloud API. */
const CLOUD_PROVIDERS = new Set([
  "anthropic", "openai", "openrouter", "google", "gemini", "nous", "glm", "kimi", "minimax", "huggingface", "nvidia",
  "xiaomi", "arcee", "deepinfra", "kilocode", "xai", "mistral", "groq", "together", "fireworks", "cohere", "deepseek",
  "bedrock", "azure", "vertex", "copilot", "codex", "perplexity",
]);
/** Providers whose default address is the user's own machine. */
const LOCAL_PROVIDERS = new Set(["ollama", "lmstudio", "lm-studio", "llama-cpp", "llamacpp", "vllm", "koboldcpp", "localai"]);

function ipv4(host: string): number[] | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return undefined;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : undefined;
}

/** Where a host name or address points: this machine, a private network, or the public internet. */
export function classifyHost(rawHost: string): HostKind {
  const host = rawHost.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) return "remote";
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "0:0:0:0:0:0:0:1") return "loopback";
  const v4 = ipv4(host);
  if (v4) {
    const [a, b] = v4;
    if (a === 127) return "loopback";
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) return "private";
    if (a === 100 && b >= 64 && b <= 127) return "private"; // carrier-grade NAT range, which Tailscale uses
    return "remote";
  }
  if (host.includes(":")) {
    // IPv6: unique-local fc00::/7 and link-local fe80::/10.
    if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) return "private";
    return "remote";
  }
  if (/\.(local|lan|internal|home\.arpa|intranet)$/.test(host)) return "private";
  if (!host.includes(".")) return "private"; // a bare name like "gpu-box" only resolves on a local network
  return "remote";
}

/**
 * Classifies a Hermes model id: `custom:<host>:<model>` by its host, `<provider>:<model>` by the provider.
 * Used to keep a model switch from quietly moving the conversation to the internet.
 */
export function classifyModelId(modelId: string, allowedHosts: readonly string[] = []): TargetKind {
  if (modelId.startsWith("custom:")) {
    // "custom:<host>:<model>" names the endpoint's host; "custom:<model>" does not, and then the configured endpoint
    // (judged on its own) is the only one it can mean. A model name with a dot ("llama3.1:8b") must not pass for a host.
    const host = CUSTOM_ID_HOST.exec(modelId)?.[1];
    if (!host) return "local";
    if (hostAllowed(host, allowedHosts)) return "allowed";
    const kind = classifyHost(host);
    return kind === "loopback" ? "local" : kind === "private" ? "private" : "remote";
  }
  const provider = modelId.split(":")[0].trim().toLowerCase();
  if (LOCAL_PROVIDERS.has(provider)) return "local";
  if (CLOUD_PROVIDERS.has(provider)) return "remote";
  return "unknown";
}

/** `*.example.com` matches subdomains (not the bare domain); anything else must match exactly. */
function hostAllowed(host: string, allowed: readonly string[]): boolean {
  const h = host.toLowerCase();
  return allowed.some((entry) => {
    const e = entry.trim().toLowerCase();
    if (!e) return false;
    return e.startsWith("*.") ? h.endsWith(e.slice(1)) && h.length > e.length - 1 : h === e;
  });
}

export interface TargetVerdict {
  kind: TargetKind;
  host?: string;
}

/** Classifies a URL against the allowed hosts (the user's own servers). */
export function classifyUrl(raw: string, allowedHosts: readonly string[] = []): TargetVerdict {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { kind: "invalid" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { kind: "invalid" };
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (hostAllowed(host, allowedHosts)) return { kind: "allowed", host };
  const kind = classifyHost(host);
  return { kind: kind === "loopback" ? "local" : kind === "private" ? "private" : "remote", host };
}

export const isAcceptable = (kind: TargetKind): boolean => kind === "local" || kind === "private" || kind === "allowed";

/** Network use in a terminal command, in the words of a short reason. Heuristic: it can only raise a flag, never prove safety. */
/** Download tools are judged by the URL they are given (see networkCommandReason); a bare `curl` with no URL is unknowable. */
const DOWNLOAD_TOOLS = /\b(curl|wget|invoke-webrequest|invoke-restmethod|iwr|irm)\b/i;

/** Commands whose remote is implicit (a git remote, a package registry), so the command line alone cannot clear them. */
const NETWORK_COMMANDS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\bgit\s+(push|pull|fetch|clone|ls-remote|submodule\s+update)\b/i, reason: "git talks to a remote" },
  { pattern: /\b(npm|pnpm|yarn|bun)\s+(install|i|add|update|upgrade|ci|publish|login)\b/i, reason: "package manager downloads from a registry" },
  { pattern: /\bpip3?\s+(install|download)\b|\bpython3?\s+-m\s+pip\s+(install|download)\b/i, reason: "package manager downloads from a registry" },
  { pattern: /\b(composer\s+(install|update|require)|cargo\s+(install|update|publish|fetch)|go\s+(get|install)|dotnet\s+(restore|add\s+package)|gem\s+install|uv\s+(pip|add|sync))\b/i, reason: "package manager downloads from a registry" },
  { pattern: /\bdocker\s+(pull|push|login|build)\b|\bgh\s+\w+/i, reason: "talks to a remote service" },
  { pattern: /\b(ssh|scp|sftp|rsync|ftp|telnet|nc|ncat|netcat|ping)\b/i, reason: "opens a network connection" },
];

/** Returns why a command may reach the network, or undefined when nothing suggests it. Loopback URLs are not flagged. */
export function networkCommandReason(command: string, allowedHosts: readonly string[] = []): string | undefined {
  let sawUrl = false;
  for (const m of command.matchAll(/https?:\/\/[^\s"'`<>)]+/gi)) {
    sawUrl = true;
    const verdict = classifyUrl(m[0], allowedHosts);
    if (!isAcceptable(verdict.kind)) return `contacts ${verdict.host ?? "an address"} on the internet`;
  }
  const implicit = NETWORK_COMMANDS.find((c) => c.pattern.test(command))?.reason;
  if (implicit) return implicit;
  // curl and friends are fine when every URL they are given stays on this machine or a named server.
  if (!sawUrl && DOWNLOAD_TOOLS.test(command)) return "downloads or sends data over the network";
  return undefined;
}

// ---- evaluating a configuration ----------------------------------------------------------------

/** An endpoint or provider mentioned in a part of the Hermes config that is used without the user choosing it per message. */
export interface ConfigEndpoint {
  path: string;
  value: string;
}

/** Top-level config blocks whose models Hermes calls on its own: summaries, fallbacks, sub-agents, mixture of agents. */
const AUTOMATIC_BLOCKS = ["auxiliary", "fallback_providers", "fallback_model", "delegation", "moa"];

/**
 * Finds provider names and base URLs under the blocks above. The user's main model and `custom_providers` are not
 * listed: the first is judged on its own, and the second only registers models that must be picked on purpose.
 */
export function scanHermesConfig(yamlText: string): ConfigEndpoint[] {
  const out: ConfigEndpoint[] = [];
  let root;
  try {
    root = parseDocument(yamlText).toJSON();
  } catch {
    return out;
  }
  if (!root || typeof root !== "object") return out;
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) node.forEach((v, i) => walk(v, `${path}[${i}]`));
    else if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        const here = `${path}.${key}`;
        if (/^(provider|base_url|api_base|baseUrl)$/i.test(key) && typeof value === "string" && value.trim()) out.push({ path: here, value: value.trim() });
        else walk(value, here);
      }
    }
  };
  for (const block of AUTOMATIC_BLOCKS) if (block in (root as Record<string, unknown>)) walk((root as Record<string, unknown>)[block], block);
  return out;
}

export type Verdict = "ok" | "blocked" | "warn" | "off";

export interface PrivacyItem {
  id: "model" | "completion" | "index" | "mcp" | "tools" | "other" | "updates" | "commands";
  /** What is being judged, e.g. the base URL. */
  target: string;
  verdict: Verdict;
  /** Message key plus its arguments, so the host can translate. */
  reason: StringKey;
  args?: (string | number)[];
}

export interface PrivacyInput {
  localOnly: boolean;
  allowedHosts: readonly string[];
  /** The model the agent will use. `provider` is only consulted when there is no base URL (the user's own Hermes config). */
  model: { kind: "hermes" | "custom"; baseUrl?: string; provider?: string };
  completion: { enabled: boolean; baseUrl: string };
  index: { enabled: boolean; baseUrl: string };
  mcpServers: { name: string; type: "stdio" | "http" | "sse"; url?: string; enabled: boolean }[];
  /** The hook that blocks network tools is installed and will run. */
  guardActive: boolean;
  /** The model selected right now (a Hermes model id); a switch to a remote one is judged like the configured endpoint. */
  currentModelId?: string;
  /** Endpoints Hermes may use on its own, found in the user's own config (profile "hermes" only). */
  configEndpoints?: ConfigEndpoint[];
}

export interface PrivacyReport {
  localOnly: boolean;
  items: PrivacyItem[];
  /** Why the agent may not start. Empty when it may. */
  blockers: PrivacyItem[];
}

/** Verdict for the model endpoint: URL first, then the provider name when the config only names a provider. */
export function judgeModelEndpoint(model: PrivacyInput["model"], allowedHosts: readonly string[]): { verdict: TargetVerdict; target: string } {
  if (model.baseUrl?.trim()) return { verdict: classifyUrl(model.baseUrl, allowedHosts), target: model.baseUrl.trim() };
  const provider = (model.provider ?? "").trim().toLowerCase();
  if (LOCAL_PROVIDERS.has(provider)) return { verdict: { kind: "local" }, target: provider };
  if (CLOUD_PROVIDERS.has(provider)) return { verdict: { kind: "remote", host: provider }, target: provider };
  return { verdict: { kind: "unknown" }, target: provider || "(none)" };
}

export function evaluatePrivacy(input: PrivacyInput): PrivacyReport {
  const items: PrivacyItem[] = [];
  const allowed = input.allowedHosts;
  const blockers: PrivacyItem[] = [];

  const model = judgeModelEndpoint(input.model, allowed);
  const modelItem: PrivacyItem = isAcceptable(model.verdict.kind)
    ? { id: "model", target: model.target, verdict: "ok", reason: "privacy.model.ok" }
    : {
        id: "model",
        target: model.target,
        verdict: input.localOnly ? "blocked" : "warn",
        reason: model.verdict.kind === "unknown" ? "privacy.model.unknown" : "privacy.model.remote",
        args: [model.target],
      };
  items.push(modelItem);
  if (input.localOnly && modelItem.verdict === "blocked") blockers.push(modelItem);

  if (input.currentModelId) {
    const kind = classifyModelId(input.currentModelId, allowed);
    if (!isAcceptable(kind) && !(modelItem.verdict === "blocked")) {
      const switched: PrivacyItem = {
        id: "model", target: input.currentModelId, verdict: input.localOnly ? "blocked" : "warn",
        reason: kind === "unknown" ? "privacy.model.unknown" : "privacy.model.remote", args: [input.currentModelId],
      };
      items.push(switched);
      if (input.localOnly) blockers.push(switched);
    }
  }

  for (const [id, f] of [["completion", input.completion], ["index", input.index]] as const) {
    if (!f.enabled) {
      items.push({ id, target: f.baseUrl, verdict: "off", reason: "privacy.feature.off" });
      continue;
    }
    const verdict = classifyUrl(f.baseUrl, allowed);
    items.push(
      isAcceptable(verdict.kind)
        ? { id, target: f.baseUrl, verdict: "ok", reason: "privacy.feature.ok" }
        : { id, target: f.baseUrl, verdict: input.localOnly ? "blocked" : "warn", reason: "privacy.feature.remote", args: [f.baseUrl] },
    );
  }

  const remoteMcp = input.mcpServers.filter((s) => s.enabled && s.type !== "stdio" && !isAcceptable(classifyUrl(s.url ?? "", allowed).kind));
  const stdioMcp = input.mcpServers.filter((s) => s.enabled && s.type === "stdio");
  if (remoteMcp.length) {
    items.push({ id: "mcp", target: remoteMcp.map((s) => s.name).join(", "), verdict: input.localOnly ? "blocked" : "warn", reason: "privacy.mcp.remote", args: [remoteMcp.map((s) => s.name).join(", ")] });
  } else if (stdioMcp.length) {
    items.push({ id: "mcp", target: stdioMcp.map((s) => s.name).join(", "), verdict: "warn", reason: "privacy.mcp.stdio", args: [stdioMcp.map((s) => s.name).join(", ")] });
  } else {
    items.push({ id: "mcp", target: "", verdict: "ok", reason: "privacy.mcp.none" });
  }

  items.push(
    input.guardActive
      ? { id: "tools", target: NETWORK_TOOLS.join(", ") + ", browser_*", verdict: "ok", reason: "privacy.tools.blocked" }
      : { id: "tools", target: NETWORK_TOOLS.join(", ") + ", browser_*", verdict: input.localOnly ? "blocked" : "warn", reason: "privacy.tools.open" },
  );
  if (input.localOnly && !input.guardActive) blockers.push(items[items.length - 1]);

  const other = (input.configEndpoints ?? []).filter((e) => {
    if (/^https?:/i.test(e.value)) return !isAcceptable(classifyUrl(e.value, allowed).kind);
    const provider = e.value.toLowerCase();
    return !LOCAL_PROVIDERS.has(provider) && provider !== "auto" && provider !== "custom";
  });
  if (other.length) {
    const list = other.map((e) => `${e.path} = ${e.value}`).join("; ");
    const item: PrivacyItem = { id: "other", target: list, verdict: input.localOnly ? "blocked" : "warn", reason: "privacy.other.remote", args: [list] };
    items.push(item);
    if (input.localOnly) blockers.push(item);
  }

  items.push({ id: "updates", target: "", verdict: input.localOnly ? "ok" : "warn", reason: input.localOnly ? "privacy.updates.off" : "privacy.updates.on" });
  items.push({ id: "commands", target: "", verdict: "warn", reason: "privacy.commands" });
  return { localOnly: input.localOnly, items, blockers };
}
