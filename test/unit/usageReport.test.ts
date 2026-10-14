import { describe, expect, it } from "vitest";
import { emptyLedger, parsePricing, recordUsage, type Ledger } from "../../src/core/usage";
import { usageReport } from "../../src/core/usageReport";

const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).getTime();
const now = at(2026, 10, 10);
const usage = (input: number, output: number, cachedRead = 0) => ({ input, output, thought: 0, cachedRead });

function ledger(): Ledger {
  let l = emptyLedger();
  l = recordUsage(l, { at: now, sessionId: "s1", profileId: "hermes", model: "claude-x", usage: usage(120_000, 8_000, 50_000) });
  l = recordUsage(l, { at: now, sessionId: "s1", profileId: "hermes", model: "mystery", usage: usage(1000, 100) });
  l = recordUsage(l, { at: at(2026, 10, 5), sessionId: "s0", profileId: "or", model: "claude-x", usage: usage(10_000, 1_000) });
  l = recordUsage(l, { at: at(2026, 8, 1), sessionId: "old", profileId: "or", model: "claude-x", usage: usage(5, 5) }); // outside 30 days
  return l;
}
const pricing = parsePricing({ "claude-x": { input: 3, output: 15, cachedInput: 0.3 } });
const base = { ledger: ledger(), pricing, currency: "$", now, sessionId: "s1", sessionTitle: "Fix login" };

describe("usageReport", () => {
  const md = usageReport({ ...base, locale: "en" });

  it("starts with the title and explains where the numbers come from", () => {
    expect(md.startsWith("# Token and cost usage\n")).toBe(true);
    expect(md).toContain("hermes.pricing");
  });

  it("has a section for the session and each time window that has data", () => {
    expect(md).toContain("## This session — Fix login");
    expect(md).toContain("## Today");
    expect(md).toContain("## Last 7 days");
    expect(md).toContain("## Last 30 days");
  });

  it("shows exact token counts abbreviated and an estimated cost where a price exists", () => {
    expect(md).toContain("| `claude-x` | 1 | 120k | 8k | ≈ $");
    // (70k fresh * 3 + 50k cached * 0.3 + 8k * 15) / 1e6 = 0.21 + 0.015 + 0.12 = 0.345
    expect(md).toContain("≈ $0.345");
  });

  it("marks models without a price and suggests how to add one", () => {
    expect(md).toContain("| `mystery` | 1 | 1k | 100 | — |");
    expect(md).toContain("Models without a price: `mystery`");
    expect(md).toContain('"hermes.pricing"');
    expect(md).toContain('"mystery"');
  });

  it("totals each table", () => {
    expect(md).toMatch(/\*\*Total\*\* \| 2 \| 121k \| 8\.1k/);
  });

  it("leaves old usage out of the windows", () => {
    expect(md).not.toContain("| 5 | 5 |");
  });

  it("reports the cache share over the last 30 days", () => {
    expect(md).toContain("50k input tokens were served from the provider's cache.");
  });

  it("is available in Indonesian", () => {
    const id = usageReport({ ...base, locale: "id" });
    expect(id).toContain("# Pemakaian token dan biaya");
    expect(id).toContain("## Sesi ini — Fix login");
    expect(id).toContain("Model tanpa harga: `mystery`");
  });

  it("says so when nothing was recorded", () => {
    const empty = usageReport({ ledger: emptyLedger(), pricing: {}, locale: "en", currency: "$", now });
    expect(empty).toContain("No usage recorded yet.");
    expect(empty).not.toContain("## Today");
  });

  it("escapes table separators in names", () => {
    let l = emptyLedger();
    l = recordUsage(l, { at: now, sessionId: "s", profileId: "a|b", model: "m|x", usage: usage(1, 1) });
    const out = usageReport({ ledger: l, pricing: {}, locale: "en", currency: "$", now });
    expect(out).toContain("a\\|b");
    expect(out).toContain("`m\\|x`");
  });
});
