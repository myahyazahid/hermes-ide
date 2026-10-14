// Where the chat lives. VS Code 1.106+ can host an extension's view in the Secondary Side Bar, the tab group next to
// Chat / Codex / Claude Code. Older builds only know the activity bar. No VS Code imports.

/** First VS Code version that accepts `contributes.viewsContainers.secondarySidebar`. */
const SECONDARY_SIDEBAR_SINCE = { major: 1, minor: 106 };

export function supportsSecondarySidebar(version: string): boolean {
  const [major, minor] = version.split(".").map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return false;
  if (major !== SECONDARY_SIDEBAR_SINCE.major) return major > SECONDARY_SIDEBAR_SINCE.major;
  return minor >= SECONDARY_SIDEBAR_SINCE.minor;
}
