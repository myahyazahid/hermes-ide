// Terminal command policy on the editor side (F-08): a per-workspace "allow always" list, and a
// set of dangerous commands that always ask even when listed (PRD security section).

const DANGEROUS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\brm\s+(-[a-z]*r[a-z]*f?|-[a-z]*f[a-z]*r|--recursive)\b/i, reason: "recursive delete" },
  { pattern: /\b(remove-item|ri|rm|del|erase)\b[^|;&]*\s-r(ecurse)?\b/i, reason: "recursive delete" },
  { pattern: /\b(rmdir|rd)\b[^|;&]*\s\/s\b/i, reason: "recursive delete" },
  { pattern: /\bdel\b[^|;&]*\s\/s\b/i, reason: "recursive delete" },
  { pattern: /\bgit\s+push\b[^|;&]*(\s--force(-with-lease)?\b|\s-f\b|\s\+\S)/i, reason: "force push" },
  { pattern: /\bgit\s+reset\s+--hard\b/i, reason: "discard changes" },
  { pattern: /\bgit\s+clean\b[^|;&]*\s-[a-z]*f/i, reason: "delete untracked files" },
  { pattern: /\bgit\s+(checkout|restore)\s+(--\s+)?\.(\s|$)/i, reason: "discard changes" },
  { pattern: /\bgit\s+branch\s+-D\b/, reason: "delete branch" },
  { pattern: /\b(mkfs(\.\w+)?|format(\.com)?)\s/i, reason: "format disk" },
  { pattern: /\bdd\s+[^|;&]*\bof=/i, reason: "raw disk write" },
  { pattern: /\b(shutdown|reboot|halt|poweroff|stop-computer|restart-computer)\b/i, reason: "power off" },
  { pattern: /\bchmod\s+(-R\s+)?[0-7]*777\b/i, reason: "world-writable permissions" },
  { pattern: /\b(curl|wget|iwr|invoke-webrequest)\b[^|]*\|\s*(sudo\s+)?(ba|z|)sh\b/i, reason: "pipe download to shell" },
  { pattern: /\b(iwr|irm|invoke-webrequest|invoke-restmethod)\b[^|]*\|\s*iex\b/i, reason: "pipe download to shell" },
  { pattern: /\bsudo\b/i, reason: "elevated privileges" },
  { pattern: /\b(drop\s+(database|table)|truncate\s+table)\b/i, reason: "destroy data" },
  { pattern: /\bnpm\s+publish\b|\bdocker\s+system\s+prune\b/i, reason: "irreversible publish/prune" },
  { pattern: /:\(\)\s*\{\s*:\|:&\s*\};:/, reason: "fork bomb" },
];

export function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

/** Returns the reason a command is dangerous, or undefined. */
export function dangerousReason(command: string): string | undefined {
  const c = normalizeCommand(command);
  return DANGEROUS.find((d) => d.pattern.test(c))?.reason;
}

export class CommandAllowlist {
  private readonly entries: Set<string>;

  constructor(entries: Iterable<string> = []) {
    this.entries = new Set([...entries].map(normalizeCommand).filter(Boolean));
  }

  /** Exact (whitespace-normalised) match only; prefixes would let `npm test && rm -rf` through. */
  allows(command: string): boolean {
    return !dangerousReason(command) && this.entries.has(normalizeCommand(command));
  }

  add(command: string): boolean {
    const c = normalizeCommand(command);
    if (!c || dangerousReason(c)) return false;
    this.entries.add(c);
    return true;
  }

  remove(command: string): void {
    this.entries.delete(normalizeCommand(command));
  }

  toJSON(): string[] {
    return [...this.entries].sort();
  }
}
