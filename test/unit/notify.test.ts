import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { encodePowerShell, parseNotifyMode, shouldNotify, toastScript, toastXml, xmlEscape } from "../../src/core/notify";

const base = { kind: "done" as const, windowFocused: false, turnMs: 30_000, minSeconds: 10 };

describe("shouldNotify", () => {
  it("is silent when switched off", () => {
    expect(shouldNotify({ ...base, mode: "off" })).toBe(false);
    expect(shouldNotify({ ...base, mode: "off", kind: "permission" })).toBe(false);
  });

  it("in 'unfocused' mode only speaks up while the window is in the background", () => {
    expect(shouldNotify({ ...base, mode: "unfocused", windowFocused: true })).toBe(false);
    expect(shouldNotify({ ...base, mode: "unfocused", windowFocused: false })).toBe(true);
    expect(shouldNotify({ ...base, mode: "unfocused", kind: "permission", windowFocused: true })).toBe(false);
    expect(shouldNotify({ ...base, mode: "unfocused", kind: "permission", windowFocused: false })).toBe(true);
  });

  it("'always' ignores focus", () => {
    expect(shouldNotify({ ...base, mode: "always", windowFocused: true })).toBe(true);
  });

  it("skips quick turns for 'done' but never delays a permission request", () => {
    expect(shouldNotify({ ...base, mode: "always", turnMs: 3_000 })).toBe(false);
    expect(shouldNotify({ ...base, mode: "always", turnMs: 10_000 })).toBe(true);
    expect(shouldNotify({ ...base, mode: "always", kind: "permission", turnMs: 0 })).toBe(true);
    expect(shouldNotify({ ...base, mode: "always", turnMs: undefined })).toBe(false);
  });

  it("treats an unknown setting value as the default", () => {
    expect(parseNotifyMode("always")).toBe("always");
    expect(parseNotifyMode("off")).toBe("off");
    expect(parseNotifyMode("sometimes")).toBe("unfocused");
    expect(parseNotifyMode(undefined)).toBe("unfocused");
  });
});

describe("toast", () => {
  it("escapes XML in the title and body", () => {
    expect(xmlEscape(`a & b <c> "d" 'e'`)).toBe("a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;");
    const xml = toastXml("Edit <file>", "x & y");
    expect(xml).toContain("<text>Edit &lt;file&gt;</text>");
    expect(xml).toContain("<text>x &amp; y</text>");
  });

  it("clips very long text", () => {
    const xml = toastXml("t".repeat(500), "b".repeat(500));
    expect(xml.length).toBeLessThan(500);
    expect(xml).toContain("…");
  });

  it("builds a script that survives apostrophes in the text and the app id", () => {
    const script = toastScript("Yahya.Hermes'IDE", "It's done", "Fixed the bug in user's file");
    expect(script).toContain("CreateToastNotifier('Yahya.Hermes''IDE')");
    expect(script).toContain("It&apos;s done".replace(/'/g, "''"));
    expect(script).toContain("$ErrorActionPreference = 'Stop'");
  });

  it("encodes the script as UTF-16LE base64 for -EncodedCommand", () => {
    const encoded = encodePowerShell("Write-Output 'é'");
    expect(Buffer.from(encoded, "base64").toString("utf16le")).toBe("Write-Output 'é'");
  });

  it.skipIf(process.platform !== "win32")("is valid PowerShell, even with hostile text", () => {
    const script = toastScript("Microsoft.VisualStudioCode", `quote ' double " dollar $x backtick \` <tag> & more`, "line1\nline2 ' end");
    const out = execFileSync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", "$errors = $null; $tokens = $null; [System.Management.Automation.Language.Parser]::ParseInput($env:SCRIPT, [ref]$tokens, [ref]$errors) | Out-Null; if ($errors.Count) { $errors | ForEach-Object { $_.Message }; exit 1 }; 'ok'"],
      { env: { ...process.env, SCRIPT: script }, encoding: "utf8" },
    );
    expect(out.trim()).toBe("ok");
  });

  // Shows a real toast; opt in with HERMES_TEST_TOAST=1 so ordinary test runs do not pop notifications up.
  it.skipIf(process.platform !== "win32" || !process.env.HERMES_TEST_TOAST)("runs on this machine without error", () => {
    const script = toastScript("Microsoft.VisualStudioCode", "Hermes IDE test", "Notification pipeline works.");
    const out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePowerShell(script)], { encoding: "utf8" });
    expect(out.trim()).toBe("");
  });
});
