import { describe, expect, it } from "vitest";
import { readReasoningEffort, withReasoningEffort } from "../../src/core/effort";

describe("reasoning effort in config.yaml", () => {
  it("reads the agent's effort, ignoring comments and other blocks", () => {
    const yaml = [
      "model:",
      "  default: x",
      "  # reasoning_effort: low",
      "auxiliary:",
      "  compression:",
      '    reasoning_effort: "low"',
      "agent:",
      "  max_turns: 90",
      "  #   reasoning_effort:",
      '  reasoning_effort: "xhigh"   # thinking level',
      "  reasoning_overrides:",
      "    gpt-5: high",
      "display:",
      "  show_reasoning: true",
    ].join("\n");
    expect(readReasoningEffort(yaml)).toBe("xhigh");
  });

  it("knows nothing when the config names no effort or one the slider does not offer", () => {
    expect(readReasoningEffort("model:\n  default: x\n")).toBeUndefined();
    expect(readReasoningEffort("agent:\n  reasoning_effort: ultra\n")).toBeUndefined();
    expect(readReasoningEffort("agent:\n  reasoning_effort: \"\"\n")).toBeUndefined();
  });

  it("replaces only the one line, keeping its comment and the rest of the file", () => {
    const yaml = 'agent:\n  max_turns: 90\n  reasoning_effort: "xhigh"   # thinking level\n  reasoning_overrides:\n    reasoning_effort: low\ndisplay:\n  x: 1\n';
    const out = withReasoningEffort(yaml, "low");
    expect(out).toBe('agent:\n  max_turns: 90\n  reasoning_effort: "low"   # thinking level\n  reasoning_overrides:\n    reasoning_effort: low\ndisplay:\n  x: 1\n');
    expect(readReasoningEffort(out)).toBe("low");
  });

  it("adds the key to an existing agent block, with its indentation", () => {
    const out = withReasoningEffort("agent:\n    max_turns: 90\ndisplay:\n  x: 1\n", "high");
    expect(out).toBe('agent:\n    reasoning_effort: "high"\n    max_turns: 90\ndisplay:\n  x: 1\n');
  });

  it("appends an agent block when there is none, keeping Windows line endings", () => {
    expect(withReasoningEffort("model:\r\n  default: x\r\n", "max")).toBe('model:\r\n  default: x\r\nagent:\r\n  reasoning_effort: "max"\r\n');
    expect(withReasoningEffort("", "medium")).toBe('agent:\n  reasoning_effort: "medium"\n');
  });

  it("leaves the text untouched when the effort is already set", () => {
    const yaml = "agent:\n  reasoning_effort: high\n";
    expect(withReasoningEffort(yaml, "high")).toBe(yaml);
  });
});
