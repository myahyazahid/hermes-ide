// Notifications (phase 5): tell the user when the agent finished or needs a permission while they are doing something
// else. This file only decides when, and builds the Windows toast; the host shows it. No VS Code imports.

export type NotifyMode = "off" | "unfocused" | "always";
export type NotifyKind = "done" | "permission";

export interface NotifyInput {
  mode: NotifyMode;
  kind: NotifyKind;
  windowFocused: boolean;
  /** How long the turn ran; short turns are not worth an interruption. Only used for "done". */
  turnMs?: number;
  minSeconds: number;
}

export function parseNotifyMode(value: unknown): NotifyMode {
  return value === "off" || value === "always" ? value : "unfocused";
}

export function shouldNotify(input: NotifyInput): boolean {
  if (input.mode === "off") return false;
  if (input.mode === "unfocused" && input.windowFocused) return false;
  if (input.kind === "done" && (input.turnMs ?? 0) < input.minSeconds * 1000) return false;
  return true;
}

export function xmlEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** A PowerShell single-quoted string literal: only the quote itself needs escaping. */
function psQuote(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

/** Toast shown by Windows. Title and body are clipped so a long file name cannot overflow the banner. */
export function toastXml(title: string, body: string): string {
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  return `<toast><visual><binding template="ToastGeneric"><text>${xmlEscape(clip(title, 80))}</text><text>${xmlEscape(clip(body, 200))}</text></binding></visual></toast>`;
}

/**
 * PowerShell that shows the toast through the WinRT API, attributed to the app identified by `aumid`. Windows only
 * displays a toast for an AppUserModelID that has a Start Menu shortcut, which VS Code and the Hermes IDE installer both create.
 */
export function toastScript(aumid: string, title: string, body: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
    "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null",
    "$xml = New-Object Windows.Data.Xml.Dom.XmlDocument",
    `$xml.LoadXml(${psQuote(toastXml(title, body))})`,
    "$toast = New-Object Windows.UI.Notifications.ToastNotification $xml",
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${psQuote(aumid)}).Show($toast)`,
  ].join("\n");
}

/** For `powershell -EncodedCommand`: base64 of the UTF-16LE script, which avoids every quoting problem. */
export function encodePowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}
