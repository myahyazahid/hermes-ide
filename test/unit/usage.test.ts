import { describe, expect, it } from "vitest";
import {
  costOf, dayKey, emptyLedger, formatMoney, formatTokenCount, fromAcpUsage, parsePricing, priceFor, pruneLedger, rangeRows, recordUsage,
  sessionTotals, type Ledger, type UsageRecord,
} from "../../src/core/usage";

const noon = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).getTime();
const rec = (over: Partial<UsageRecord> = {}): UsageRecord => ({
  at: noon(2026, 10, 10), sessionId: "s1", profileId: "hermes", model: "claude-x",
  usage: { input: 1000, output: 200, thought: 50, cachedRead: 0 }, ...over,
});

describe("fromAcpUsage", () => {
  it("maps Hermes' ACP usage and tolerates missing extras", () => {
    expect(fromAcpUsage({ inputTokens: 120, outputTokens: 30, thoughtTokens: null, cachedReadTokens: 40 })).toEqual({ input: 120, output: 30, thought: 0, cachedRead: 40 });
  });

  it("returns undefined when nothing countable was reported", () => {
    expect(fromAcpUsage(undefined)).toBeUndefined();
    expect(fromAcpUsage({ inputTokens: 0, outputTokens: 0 })).toBeUndefined();
    expect(fromAcpUsage({ inputTokens: Number.NaN, outputTokens: -5 })).toBeUndefined();
  });
});

describe("pricing", () => {
  it("accepts only complete, non-negative entries", () => {
    expect(parsePricing({
      "claude-x": { input: 3, output: 15, cachedInput: 0.3 },
      "no-output": { input: 1 },
      "negative": { input: -1, output: 2 },
      "junk": "x",
    })).toEqual({ "claude-x": { input: 3, output: 15, cachedInput: 0.3 } });
    expect(parsePricing(null)).toEqual({});
    expect(parsePricing([1, 2])).toEqual({});
  });

  const table = parsePricing({ "claude-x": { input: 3, output: 15 }, "gpt-4o": { input: 2.5, output: 10 }, "4o": { input: 9, output: 9 } });

  it("matches exactly, without provider prefix, and by longest suffix", () => {
    expect(priceFor("claude-x", table)?.input).toBe(3);
    expect(priceFor("anthropic/claude-x", table)?.input).toBe(3);
    expect(priceFor("custom:router.example.com:claude-x", table)?.input).toBe(3);
    expect(priceFor("openai/gpt-4o", table)?.input).toBe(2.5);
    expect(priceFor("CLAUDE-X", table)?.input).toBe(3);
    expect(priceFor("mystery", table)).toBeUndefined();
    expect(priceFor(undefined, table)).toBeUndefined();
  });

  it("computes cost per million tokens, discounting cached input only when a cached price exists", () => {
    const usage = { input: 1_000_000, output: 100_000, thought: 30_000, cachedRead: 400_000 };
    // 600k fresh * 3 + 400k cached * 3 (no discount given) + 100k * 15 = 1.8 + 1.2 + 1.5
    expect(costOf(usage, { input: 3, output: 15 })).toBeCloseTo(4.5);
    // cached at 0.3: 1.8 + 0.12 + 1.5
    expect(costOf(usage, { input: 3, output: 15, cachedInput: 0.3 })).toBeCloseTo(3.42);
  });

  it("never bills reasoning tokens on top of output, and clamps cached to input", () => {
    expect(costOf({ input: 0, output: 1_000_000, thought: 900_000, cachedRead: 0 }, { input: 1, output: 2 })).toBeCloseTo(2);
    expect(costOf({ input: 100, output: 0, thought: 0, cachedRead: 500 }, { input: 10, output: 0, cachedInput: 1 })).toBeCloseTo(0.0001);
  });
});

describe("ledger", () => {
  it("adds turns per day, profile, model and session without mutating the input", () => {
    const empty = emptyLedger();
    const a = recordUsage(empty, rec());
    const b = recordUsage(a, rec({ usage: { input: 500, output: 100, thought: 0, cachedRead: 100 } }));
    expect(empty).toEqual(emptyLedger());
    const bucket = b.days[dayKey(noon(2026, 10, 10))].hermes["claude-x"];
    expect(bucket).toEqual({ input: 1500, output: 300, thought: 50, cachedRead: 100, turns: 2 });
    expect(b.sessions.s1.models["claude-x"].turns).toBe(2);
  });

  it("totals a session across models and reports models without a price", () => {
    let l: Ledger = recordUsage(emptyLedger(), rec());
    l = recordUsage(l, rec({ model: "mystery", usage: { input: 10, output: 10, thought: 0, cachedRead: 0 } }));
    const totals = sessionTotals(l, "s1", parsePricing({ "claude-x": { input: 3, output: 15 } }))!;
    expect(totals.usage).toMatchObject({ input: 1010, output: 210 });
    expect(totals.turns).toBe(2);
    expect(totals.cost).toBeCloseTo((1000 * 3 + 200 * 15) / 1e6);
    expect(totals.unpriced).toEqual(["mystery"]);
    expect(sessionTotals(l, "nope", {})).toBeUndefined();
    expect(sessionTotals(l, undefined, {})).toBeUndefined();
  });

  it("has no cost at all when no model is priced", () => {
    expect(sessionTotals(recordUsage(emptyLedger(), rec()), "s1", {})?.cost).toBeUndefined();
  });

  it("aggregates a day range per profile and model, most expensive first", () => {
    let l = emptyLedger();
    l = recordUsage(l, rec({ at: noon(2026, 10, 8), profileId: "or", model: "claude-x" }));
    l = recordUsage(l, rec({ at: noon(2026, 10, 10), profileId: "or", model: "claude-x" }));
    l = recordUsage(l, rec({ at: noon(2026, 10, 10), profileId: "hermes", model: "cheap", usage: { input: 5, output: 5, thought: 0, cachedRead: 0 } }));
    l = recordUsage(l, rec({ at: noon(2026, 9, 1), profileId: "or", model: "claude-x" })); // outside the range
    const rows = rangeRows(l, dayKey(noon(2026, 10, 1)), dayKey(noon(2026, 10, 31)), parsePricing({ "claude-x": { input: 3, output: 15 } }));
    expect(rows.map((r) => `${r.profileId}/${r.model}`)).toEqual(["or/claude-x", "hermes/cheap"]);
    expect(rows[0].usage.input).toBe(2000);
    expect(rows[0].turns).toBe(2);
    expect(rows[0].cost).toBeGreaterThan(0);
    expect(rows[1].cost).toBeUndefined();
  });

  it("prunes old days and surplus sessions", () => {
    let l = emptyLedger();
    for (let d = 1; d <= 5; d++) l = recordUsage(l, rec({ at: noon(2026, 10, d), sessionId: `s${d}` }));
    const pruned = pruneLedger(l, { maxDays: 2, maxSessions: 3 });
    expect(Object.keys(pruned.days)).toEqual([dayKey(noon(2026, 10, 4)), dayKey(noon(2026, 10, 5))]);
    expect(Object.keys(pruned.sessions).sort()).toEqual(["s3", "s4", "s5"]);
  });
});

describe("formatting", () => {
  it("abbreviates token counts", () => {
    expect([0, 999, 1000, 1500, 12_345, 1_500_000, 2_000_000, 25_000_000].map(formatTokenCount)).toEqual(["0", "999", "1k", "1.5k", "12k", "1.5M", "2M", "25M"]);
  });

  it("keeps enough digits for small amounts", () => {
    expect([0, 0.0042, 0.25, 12.3].map((n) => formatMoney(n, "$"))).toEqual(["$0.00", "$0.0042", "$0.250", "$12.30"]);
  });
});
