// Persists token usage (phase 5) in global state and turns it into the session chip and the report.
import * as vscode from "vscode";
import type { UsageView } from "../shared/protocol";
import type { Locale } from "../shared/strings";
import {
  emptyLedger, parsePricing, pruneLedger, recordUsage, sessionTotals, type Ledger, type PricingTable, type UsageRecord,
} from "../core/usage";
import { usageReport } from "../core/usageReport";

const LEDGER_KEY = "hermes.usageLedger";

function loadLedger(raw: unknown): Ledger {
  const l = raw as Ledger | undefined;
  return l && l.v === 1 && typeof l.days === "object" && typeof l.sessions === "object" ? l : emptyLedger();
}

export class UsageTracker {
  private ledger: Ledger;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.ledger = loadLedger(context.globalState.get(LEDGER_KEY));
  }

  record(rec: UsageRecord): void {
    this.ledger = pruneLedger(recordUsage(this.ledger, rec));
    void this.context.globalState.update(LEDGER_KEY, this.ledger);
  }

  pricing(): PricingTable {
    return parsePricing(vscode.workspace.getConfiguration("hermes").get("pricing"));
  }

  currency(): string {
    return vscode.workspace.getConfiguration("hermes").get<string>("usage.currency")?.trim() || "$";
  }

  /** Totals for the chip in the session bar; undefined until the session has a counted turn. */
  view(sessionId: string | undefined): UsageView | undefined {
    const totals = sessionTotals(this.ledger, sessionId, this.pricing());
    if (!totals) return undefined;
    return {
      input: totals.usage.input,
      output: totals.usage.output,
      thought: totals.usage.thought,
      cached: totals.usage.cachedRead,
      turns: totals.turns,
      cost: totals.cost,
      currency: this.currency(),
      unpriced: totals.unpriced.length > 0,
    };
  }

  report(locale: Locale, sessionId?: string, sessionTitle?: string): string {
    return usageReport({ ledger: this.ledger, pricing: this.pricing(), locale, currency: this.currency(), now: Date.now(), sessionId, sessionTitle });
  }
}
