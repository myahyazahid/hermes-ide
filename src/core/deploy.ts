// Deploying to a VPS over SSH from the agent panel (phase 7). The IDE never runs a deploy itself: the agent does, through
// its terminal tool, and every command it runs asks for permission like any other. What this module adds is the part
// around that: the servers the user registered, recognising an ssh/scp/sftp/rsync command so its card says "deploy" (and
// never offers "always allow"), spotting what is risky on the server side, a connection check, and the prompt that sets
// the agent's ground rules. Nothing here holds a secret: a target names a key file, never its content or a password.
//
// Recognising commands is heuristic text analysis. It can raise a flag, never prove a command safe.

export interface DeployTarget {
  name: string;
  host: string;
  user: string;
  port?: number;
  /** Path to a private key file. Only the path is stored. */
  identityFile?: string;
  /** Folder on the server the project lives in. */
  path?: string;
  /** Name of a git remote that points at this server ("git push <remote>" then counts as a deploy). */
  gitRemote?: string;
  /** The user's own deploy steps, in their words; handed to the agent as given. */
  steps?: string;
}

const NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,39}$/u;
const HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|[0-9A-Fa-f:]{2,45})$/;
const USER = /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/;
const REMOTE_PATH = /^\/[A-Za-z0-9._/~@%+=:,-]{0,200}$/;
const GIT_REMOTE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/;

export type TargetProblem = "name" | "host" | "user" | "port" | "identityFile" | "path" | "gitRemote" | "steps";

/** The first thing wrong with a target, or undefined. The values end up on an ssh command line, so they are strict. */
export function validateTarget(t: DeployTarget): TargetProblem | undefined {
  if (!NAME.test(t.name)) return "name";
  if (!HOST.test(t.host)) return "host";
  if (!USER.test(t.user)) return "user";
  if (t.port !== undefined && !(Number.isInteger(t.port) && t.port >= 1 && t.port <= 65535)) return "port";
  if (t.identityFile !== undefined && (t.identityFile.length > 260 || /["'`$\r\n]|^-/.test(t.identityFile) || !t.identityFile.trim())) return "identityFile";
  if (t.path !== undefined && !REMOTE_PATH.test(t.path)) return "path";
  if (t.gitRemote !== undefined && !GIT_REMOTE.test(t.gitRemote)) return "gitRemote";
  if (t.steps !== undefined && t.steps.length > 2000) return "steps";
  return undefined;
}

/** Targets from the setting: anything that is not a valid target is dropped, duplicates (by name) keep the first. */
export function parseTargets(raw: unknown): DeployTarget[] {
  if (!Array.isArray(raw)) return [];
  const targets: DeployTarget[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    const target: DeployTarget = {
      name: text(r.name) ?? "", host: text(r.host) ?? "", user: text(r.user) ?? "",
      ...(typeof r.port === "number" ? { port: r.port } : {}),
      ...(text(r.identityFile) ? { identityFile: text(r.identityFile) } : {}),
      ...(text(r.path) ? { path: text(r.path) } : {}),
      ...(text(r.gitRemote) ? { gitRemote: text(r.gitRemote) } : {}),
      ...(text(r.steps) ? { steps: text(r.steps) } : {}),
    };
    if (validateTarget(target) || targets.some((t) => t.name.toLowerCase() === target.name.toLowerCase())) continue;
    targets.push(target);
  }
  return targets;
}

// ---- recognising ssh-family commands -------------------------------------------------------------

export type SshTool = "ssh" | "scp" | "sftp" | "rsync" | "plink";
const SSH_TOOLS: ReadonlySet<string> = new Set<SshTool>(["ssh", "scp", "sftp", "rsync", "plink"]);
const WRAPPERS = new Set(["sudo", "time", "nohup", "env", "command", "exec", "nice"]);

export interface RemoteHost {
  user?: string;
  host: string;
  port?: number;
}

export interface Invocation {
  tool: SshTool;
  hosts: RemoteHost[];
  /** What ssh is asked to run on the server (empty for a plain login). */
  remote?: string;
  /** Options that make the connection less safe. */
  weakened: boolean;
}

/** Splits a command line into segments (on && || ; | and newlines outside quotes), each into words with quotes removed. */
export function tokenize(command: string): string[][] {
  const segments: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: '"' | "'" | undefined;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length) segments.push(words);
    words = [];
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = undefined;
      else if (c === "\\" && quote === '"' && i + 1 < command.length && /["\\$`]/.test(command[i + 1])) word += command[++i];
      else word += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      inWord = true;
    } else if (c === "\\" && i + 1 < command.length && /[\s"'\\$`;|&()<>]/.test(command[i + 1])) {
      // An escape in POSIX shells. Before any other character the backslash is kept: it is a Windows path separator.
      word += command[++i];
      inWord = true;
    } else if (/\s/.test(c)) {
      if (c === "\n" || c === "\r") endSegment();
      else endWord();
    } else if (c === ";" || c === "|" || c === "&") {
      if ((c === "&" || c === "|") && command[i + 1] === c) i++;
      endSegment();
    } else {
      word += c;
      inWord = true;
    }
  }
  endSegment();
  return segments;
}

const SSH_ARG_OPTIONS = new Set(["-b", "-c", "-D", "-E", "-e", "-F", "-I", "-i", "-J", "-L", "-l", "-m", "-O", "-o", "-p", "-Q", "-R", "-S", "-W", "-w"]);
const SCP_ARG_OPTIONS = new Set(["-c", "-D", "-F", "-i", "-J", "-l", "-o", "-P", "-S", "-X"]);
const RSYNC_ARG_OPTIONS = new Set(["-e", "--rsh", "--port", "--include", "--exclude", "--filter", "--rsync-path", "--chmod", "--bwlimit", "--timeout"]);
const WEAKENED = /StrictHostKeyChecking\s*=?\s*(no|off|false)|UserKnownHostsFile\s*=?\s*(\/dev\/null|NUL)|CheckHostIP\s*=?\s*no/i;

function baseName(word: string): string {
  return word.replace(/^.*[\\/]/, "").replace(/\.exe$/i, "").toLowerCase();
}

/** "user@host", "host", "ssh://user@host:2222/path", "[::1]". */
function parseHost(spec: string): RemoteHost | undefined {
  let text = spec.replace(/^ssh:\/\//i, "");
  text = text.replace(/\/.*$/, "");
  let user: string | undefined;
  const at = text.lastIndexOf("@");
  if (at >= 0) {
    user = text.slice(0, at);
    text = text.slice(at + 1);
  }
  let port: number | undefined;
  const bracket = /^\[([^\]]+)\](?::(\d+))?$/.exec(text);
  if (bracket) {
    text = bracket[1];
    if (bracket[2]) port = Number(bracket[2]);
  } else {
    const colon = /^([^:]+):(\d+)$/.exec(text);
    if (colon) {
      text = colon[1];
      port = Number(colon[2]);
    }
  }
  return text ? { host: text, ...(user ? { user } : {}), ...(port ? { port } : {}) } : undefined;
}

/** [user@]host:path as scp and rsync write it; a single letter before the colon is a Windows drive, not a host. */
function parseRemoteSpec(word: string): RemoteHost | undefined {
  if (word.startsWith("-")) return undefined;
  if (/^ssh:\/\//i.test(word)) return parseHost(word);
  const m = /^(?:([^@\s:/\\]+)@)?(\[[^\]]+\]|[^:\s/\\@]+):/.exec(word);
  if (!m) return undefined;
  if (!m[1] && m[2].length < 2) return undefined; // "C:" is a drive; "user@c:" is a host
  return { host: m[2].replace(/^\[|\]$/g, ""), ...(m[1] ? { user: m[1] } : {}) };
}

function analyzeSegment(words: string[]): Invocation | undefined {
  let i = 0;
  while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || WRAPPERS.has(baseName(words[i])))) {
    // sudo -u root ssh ...: skip the option and its argument
    if (baseName(words[i]) === "sudo") {
      i++;
      while (i < words.length && words[i].startsWith("-")) i += words[i] === "-u" || words[i] === "-g" ? 2 : 1;
    } else i++;
  }
  const tool = words[i] ? baseName(words[i]) : "";
  if (!SSH_TOOLS.has(tool)) return undefined;
  const args = words.slice(i + 1);
  let weakened = false;
  const hosts: RemoteHost[] = [];
  let remote: string | undefined;
  let port: number | undefined;
  let loginUser: string | undefined;

  if (tool === "ssh" || tool === "plink" || tool === "sftp") {
    const takesArg = tool === "sftp" ? new Set(["-B", "-b", "-c", "-D", "-F", "-i", "-J", "-l", "-o", "-P", "-R", "-S", "-s"]) : SSH_ARG_OPTIONS;
    for (let k = 0; k < args.length; k++) {
      const a = args[k];
      if (a.startsWith("-") && a !== "-") {
        const opt = a.length > 2 && takesArg.has(a.slice(0, 2)) ? a.slice(0, 2) : a;
        const inline = a.length > 2 && takesArg.has(a.slice(0, 2)) ? a.slice(2) : undefined;
        const value = takesArg.has(opt) ? (inline ?? args[++k] ?? "") : "";
        if (opt === "-o" && WEAKENED.test(value)) weakened = true;
        if ((opt === "-p" || opt === "-P") && /^\d+$/.test(value)) port = Number(value);
        if (opt === "-l") loginUser = value;
        continue;
      }
      const host = parseHost(a);
      if (host) hosts.push({ ...host, ...(port && !host.port ? { port } : {}), ...(loginUser && !host.user ? { user: loginUser } : {}) });
      if (tool !== "sftp") remote = args.slice(k + 1).join(" ").trim() || undefined;
      break;
    }
  } else {
    const takesArg = tool === "scp" ? SCP_ARG_OPTIONS : RSYNC_ARG_OPTIONS;
    for (let k = 0; k < args.length; k++) {
      const a = args[k];
      if (a.startsWith("-")) {
        const opt = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
        const value = takesArg.has(opt) && !a.includes("=") ? args[++k] ?? "" : a.includes("=") ? a.slice(a.indexOf("=") + 1) : "";
        if ((opt === "-o" || opt === "-e" || opt === "--rsh") && WEAKENED.test(value)) weakened = true;
        continue;
      }
      const host = parseRemoteSpec(a);
      if (host) hosts.push(host);
    }
  }
  return { tool: tool as SshTool, hosts, ...(remote ? { remote } : {}), weakened };
}

/**
 * Every ssh-family invocation in a command line. When the text mentions one of the tools but the analysis cannot make
 * sense of it (odd quoting, a subshell), a host-less invocation is returned so the command is still treated as a deploy.
 */
export function analyzeCommand(command: string): Invocation[] {
  const found = tokenize(command).map(analyzeSegment).filter((x): x is Invocation => !!x);
  if (found.length) return found;
  const word = /(?:^|[\s;&|(`$"'=\\/])(ssh|scp|sftp|rsync|plink)(?:\.exe)?(?=[\s"')`;&|]|$)/i.exec(command);
  return word ? [{ tool: word[1].toLowerCase() as SshTool, hosts: [], weakened: WEAKENED.test(command) }] : [];
}

/** Remotes named in `git push <remote>` (the usual "push to deploy" setup). */
export function gitPushRemotes(command: string): string[] {
  const remotes: string[] = [];
  for (const words of tokenize(command)) {
    const at = words.findIndex((w, i) => baseName(w) === "git" && words[i + 1] !== undefined);
    if (at < 0) continue;
    // git -C <dir> and -c <key=value> take an argument before the subcommand
    const rest: string[] = [];
    for (let k = at + 1; k < words.length; k++) {
      if (words[k] === "-C" || words[k] === "-c") k++;
      else if (!(words[k].startsWith("-") && words[k] !== "-")) rest.push(words[k]);
    }
    if (rest[0] === "push" && rest[1]) remotes.push(rest[1]);
  }
  return remotes;
}

export function matchTarget(host: RemoteHost, targets: readonly DeployTarget[]): DeployTarget | undefined {
  return targets.find((t) => {
    const same = t.host.toLowerCase() === host.host.toLowerCase() || t.name.toLowerCase() === host.host.toLowerCase();
    return same && (!host.user || host.user === t.user || t.name.toLowerCase() === host.host.toLowerCase());
  });
}

// ---- what is risky on the server --------------------------------------------------------------

export type RiskCode =
  | "rm" | "disk" | "sql" | "dbReset" | "gitDestructive" | "permissions" | "serviceStop" | "power" | "firewall" | "accounts" | "pipeShell" | "docker" | "kill" | "hostKey"
  | "sudo" | "migrate" | "restart" | "packages";

export interface Risk {
  code: RiskCode;
  severity: "danger" | "caution";
}

const RISK_RULES: { code: RiskCode; severity: Risk["severity"]; pattern: RegExp }[] = [
  { code: "rm", severity: "danger", pattern: /\brm\s+(?:-[A-Za-z]*\s+)*-[A-Za-z]*[rRf][A-Za-z]*\b|\brm\s+--(?:recursive|force)\b/ },
  { code: "disk", severity: "danger", pattern: /\b(dd\s+if=|mkfs(?:\.\w+)?\b|shred\b|wipefs\b|fdisk\b|parted\b)|>\s*\/dev\/(?:sd|nvme|vd)/ },
  { code: "sql", severity: "danger", pattern: /\b(DROP\s+(?:DATABASE|TABLE|SCHEMA)|TRUNCATE(?:\s+TABLE)?|DELETE\s+FROM\s+\w+\s*(?:;|$|"|'))/i },
  { code: "dbReset", severity: "danger", pattern: /\b(migrate:fresh|migrate:reset|migrate:rollback|db:wipe|db:drop|dropdb)\b/ },
  { code: "gitDestructive", severity: "danger", pattern: /\bgit\s+(?:reset\s+--hard|clean\s+-[A-Za-z]*f|checkout\s+--\s*\.|push\s+(?:.*\s)?(?:--force|-f)\b)/ },
  { code: "permissions", severity: "danger", pattern: /\bch(?:mod|own)\s+(?:-[A-Za-z]*R[A-Za-z]*\s|--recursive\s)|\bchmod\s+(?:-\w+\s+)?0?777\b/ },
  { code: "serviceStop", severity: "danger", pattern: /\b(?:systemctl\s+(?:stop|disable|mask|kill)|service\s+\S+\s+stop)\b/ },
  { code: "power", severity: "danger", pattern: /\b(?:reboot|shutdown|poweroff|halt)\b|\binit\s+[06]\b/ },
  { code: "firewall", severity: "danger", pattern: /\b(?:iptables\s+(?:-F|--flush)|ufw\s+(?:disable|reset)|nft\s+flush)\b/ },
  { code: "accounts", severity: "danger", pattern: /\b(?:userdel|usermod|passwd|visudo|deluser|adduser)\b|\/etc\/(?:sudoers|passwd|shadow)/ },
  { code: "pipeShell", severity: "danger", pattern: /\b(?:curl|wget)\b[^|;&]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/ },
  { code: "docker", severity: "danger", pattern: /\bdocker\s+(?:system\s+prune|volume\s+(?:rm|prune)|rm\s+-f|rmi|compose\s+down\s+(?:.*\s)?-v)\b/ },
  { code: "kill", severity: "danger", pattern: /\b(?:kill\s+-9|killall|pkill)\b/ },
  { code: "sudo", severity: "caution", pattern: /\bsudo\b/ },
  { code: "migrate", severity: "caution", pattern: /\b(?:artisan\s+migrate|migrate\b(?!:)|prisma\s+migrate\s+deploy|alembic\s+upgrade|rails\s+db:migrate)/ },
  { code: "restart", severity: "caution", pattern: /\b(?:systemctl\s+(?:restart|reload)|service\s+\S+\s+(?:restart|reload)|supervisorctl\s+(?:restart|stop)|pm2\s+(?:restart|reload|delete))\b/ },
  { code: "packages", severity: "caution", pattern: /\b(?:apt(?:-get)?|yum|dnf|apk|pacman)\s+(?:-\S+\s+)*(?:install|remove|purge|upgrade|dist-upgrade|autoremove)\b/ },
];

/** What looks risky in a command that will run on a server (or in the connection options). Order: danger first. */
export function remoteRisks(remote: string, weakened = false): Risk[] {
  const risks: Risk[] = RISK_RULES.filter((r) => r.pattern.test(remote)).map((r) => ({ code: r.code, severity: r.severity }));
  if (weakened) risks.push({ code: "hostKey", severity: "danger" });
  return risks.sort((a, b) => Number(b.severity === "danger") - Number(a.severity === "danger"));
}

export interface DeployAnalysis {
  invocations: Invocation[];
  /** The registered targets this command talks to. */
  targets: DeployTarget[];
  /** Hosts it talks to that are not registered. */
  unknownHosts: string[];
  risks: Risk[];
}

/** Null when the command has nothing to do with a remote server. */
export function analyzeDeploy(command: string, targets: readonly DeployTarget[]): DeployAnalysis | null {
  const invocations = analyzeCommand(command);
  const remotes = gitPushRemotes(command);
  const pushTargets = targets.filter((t) => t.gitRemote && remotes.includes(t.gitRemote));
  if (!invocations.length && !pushTargets.length) return null;
  const matched: DeployTarget[] = [...pushTargets];
  const unknown: string[] = [];
  let risks: Risk[] = [];
  for (const inv of invocations) {
    if (!inv.hosts.length) unknown.push("?");
    for (const host of inv.hosts) {
      const t = matchTarget(host, targets);
      if (t) {
        if (!matched.includes(t)) matched.push(t);
      } else if (!unknown.includes(host.host)) unknown.push(host.host);
    }
    risks = risks.concat(remoteRisks(inv.remote ?? "", inv.weakened));
  }
  if (pushTargets.length) risks = risks.concat(remoteRisks(command));
  const unique = risks.filter((r, i) => risks.findIndex((x) => x.code === r.code) === i);
  return { invocations, targets: matched, unknownHosts: unknown, risks: unique.sort((a, b) => Number(b.severity === "danger") - Number(a.severity === "danger")) };
}

// ---- connection check -------------------------------------------------------------------------

export type ConnectionVerdict = "ok" | "hostKey" | "hostKeyChanged" | "auth" | "refused" | "timeout" | "dns" | "network" | "noSsh" | "other";

/** Arguments for a non-interactive login that runs `true`. BatchMode refuses to ask anything, so it can never hang on a prompt. */
export function checkArgs(t: DeployTarget): string[] {
  return [
    "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
    ...(t.port ? ["-p", String(t.port)] : []),
    ...(t.identityFile ? ["-i", t.identityFile] : []),
    `${t.user}@${t.host}`, "true",
  ];
}

export function classifyConnection(code: number | null, output: string, spawnFailed = false): ConnectionVerdict {
  if (spawnFailed) return "noSsh";
  if (code === 0) return "ok";
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|host key .* (?:has|have) changed/i.test(output)) return "hostKeyChanged";
  if (/Host key verification failed/i.test(output)) return "hostKey";
  if (/Permission denied|Too many authentication failures/i.test(output)) return "auth";
  if (/Connection refused/i.test(output)) return "refused";
  if (/timed out|Operation timed out|Connection timeout/i.test(output)) return "timeout";
  if (/Could not resolve hostname|Name or service not known|nodename nor servname|No such host is known/i.test(output)) return "dns";
  if (/No route to host|Network is unreachable/i.test(output)) return "network";
  return "other";
}

// ---- the prompt that sets the agent's ground rules --------------------------------------------

export function deployPrompt(t: DeployTarget, language: "id" | "en"): string {
  const where = `${t.user}@${t.host}${t.port ? `:${t.port}` : ""}`;
  const key = t.identityFile ? ` -i "${t.identityFile}"` : "";
  const portFlag = t.port ? ` -p ${t.port}` : "";
  const command = `ssh${portFlag}${key} ${t.user}@${t.host} "<command>"`;
  if (language === "id") {
    return [
      `Deploy proyek ini ke server "${t.name}" (${where}${t.path ? `, folder ${t.path}` : ""}).`,
      "",
      "Aturan:",
      `- Sambung ke server hanya lewat \`${command}\`, satu perintah per pemanggilan, dan tulis dulu apa yang akan dijalankan serta alasannya.`,
      "- Mulai dengan rencana deploy (langkah, risiko, dan cara rollback) dan tunggu persetujuanku sebelum menjalankan apa pun di server.",
      "- Jangan menjalankan perintah yang menghapus atau mereset data (rm -rf, migrate:fresh, DROP, dan sejenisnya) tanpa konfirmasi eksplisit dariku.",
      "- Jangan membaca atau mencetak berkas rahasia (.env, kunci privat), dan jangan meminta atau memakai kata sandi: koneksi memakai kunci SSH.",
      "- Jangan menonaktifkan pemeriksaan host key SSH.",
      "- Sebelum deploy pastikan tes lulus dan perubahan sudah di-commit. Setelah deploy, verifikasi (mis. status layanan atau health check) dan laporkan hasilnya.",
      "",
      t.steps ? `Langkah deploy yang biasa kupakai:\n${t.steps}` : "Aku belum menulis langkah deploy: usulkan berdasarkan jenis proyek ini, lalu tunggu persetujuanku.",
    ].join("\n");
  }
  return [
    `Deploy this project to the server "${t.name}" (${where}${t.path ? `, folder ${t.path}` : ""}).`,
    "",
    "Ground rules:",
    `- Connect to the server only through \`${command}\`, one command per invocation, and say first what it will run and why.`,
    "- Start with a deploy plan (steps, risks and how to roll back) and wait for my approval before running anything on the server.",
    "- Do not run commands that delete or reset data (rm -rf, migrate:fresh, DROP and the like) without my explicit confirmation.",
    "- Do not read or print secret files (.env, private keys), and do not ask for or use passwords: the connection uses an SSH key.",
    "- Do not disable SSH host key checking.",
    "- Before deploying make sure the tests pass and the changes are committed. After deploying, verify (e.g. service status or a health check) and report the result.",
    "",
    t.steps ? `The deploy steps I usually use:\n${t.steps}` : "I have not written down deploy steps: propose them for this kind of project, then wait for my approval.",
  ].join("\n");
}

// ---- history ------------------------------------------------------------------------------------

export interface DeployRecord {
  at: number;
  /** Registered target name, or the host when it was not registered. */
  target: string;
  registered: boolean;
  command: string;
  outcome: "allowed" | "rejected" | "cancelled";
  risks: RiskCode[];
}

export const MAX_HISTORY = 200;

export function trimCommand(command: string): string {
  return command.length > 600 ? `${command.slice(0, 600)}…` : command;
}

export function addRecord(history: readonly DeployRecord[], record: DeployRecord): DeployRecord[] {
  return [...history, record].slice(-MAX_HISTORY);
}
