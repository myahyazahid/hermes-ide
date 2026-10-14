// The "token and cost usage" report (phase 5) as a Markdown document: this session, today, 7 and 30 days.
import { t, type Locale } from "../shared/strings";
import { costOf, dayKey, formatMoney, formatTokenCount, priceFor, rangeRows, type Ledger, type PricingTable, type UsageRow } from "./usage";

export interface ReportOptions {
  ledger: Ledger;
  pricing: PricingTable;
  locale: Locale;
  currency: string;
  now: number;
  sessionId?: string;
  sessionTitle?: string;
}

function daysAgo(now: number, n: number): number {
  const d = new Date(now);
  d.setDate(d.getDate() - n);
  return d.getTime();
}

const cell = (text: string) => text.replace(/\|/g, "\\|");

function cost(row: { cost?: number }, currency: string): string {
  return row.cost === undefined ? "—" : `≈ ${formatMoney(row.cost, currency)}`;
}

function table(rows: UsageRow[], opts: { withProfile: boolean; locale: Locale; currency: string }): string {
  const { locale, currency, withProfile } = opts;
  const head = [...(withProfile ? [t(locale, "report.colProfile")] : []), t(locale, "report.colModel"), t(locale, "report.colTurns"), t(locale, "report.colIn"), t(locale, "report.colOut"), t(locale, "report.colCost")];
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  const body = rows.map((r) => line([...(withProfile ? [cell(r.profileId)] : []), `\`${cell(r.model)}\``, String(r.turns), formatTokenCount(r.usage.input), formatTokenCount(r.usage.output), cost(r, currency)]));
  const priced = rows.filter((r) => r.cost !== undefined);
  const total = {
    turns: rows.reduce((n, r) => n + r.turns, 0),
    input: rows.reduce((n, r) => n + r.usage.input, 0),
    output: rows.reduce((n, r) => n + r.usage.output, 0),
    cost: priced.length ? priced.reduce((n, r) => n + (r.cost ?? 0), 0) : undefined,
  };
  const foot = line([...(withProfile ? [""] : []), `**${t(locale, "report.total")}**`, String(total.turns), formatTokenCount(total.input), formatTokenCount(total.output), cost(total, currency)]);
  return [line(head), line(head.map(() => "---")), ...body, foot].join("\n");
}

export function usageReport(opts: ReportOptions): string {
  const { ledger, pricing, locale, currency, now } = opts;
  const out: string[] = [`# ${t(locale, "report.title")}`, t(locale, "report.intro")];
  const unpriced = new Set<string>();
  let cached = 0;
  const note = (rows: UsageRow[]) => {
    for (const r of rows) if (r.cost === undefined) unpriced.add(r.model);
  };

  const session = opts.sessionId ? ledger.sessions[opts.sessionId] : undefined;
  if (session) {
    const rows: UsageRow[] = Object.entries(session.models).map(([model, b]) => {
      const price = priceFor(model, pricing);
      const row: UsageRow = { profileId: session.profileId, model, usage: b, turns: b.turns };
      return price ? { ...row, cost: costOf(b, price) } : row;
    });
    note(rows);
    out.push(`## ${t(locale, "report.session")}${opts.sessionTitle ? ` — ${cell(opts.sessionTitle)}` : ""}`, table(rows, { withProfile: false, locale, currency }));
  }

  const windows: [string, number][] = [["report.today", 0], ["report.days7", 6], ["report.days30", 29]];
  let any = false;
  for (const [key, back] of windows) {
    const rows = rangeRows(ledger, dayKey(daysAgo(now, back)), dayKey(now), pricing);
    if (!rows.length) continue;
    any = true;
    note(rows);
    if (back === 29) cached = rows.reduce((n, r) => n + r.usage.cachedRead, 0);
    out.push(`## ${t(locale, key as Parameters<typeof t>[1])}`, table(rows, { withProfile: true, locale, currency }));
  }
  if (!session && !any) out.push(t(locale, "report.noData"));
  if (cached > 0) out.push(t(locale, "report.cached", formatTokenCount(cached)));

  if (unpriced.size) {
    const example = Object.fromEntries([...unpriced].slice(0, 2).map((m) => [m, { input: 3, output: 15 }]));
    out.push(
      t(locale, "report.unpriced", [...unpriced].map((m) => `\`${m}\``).join(", ")),
      "```json\n" + JSON.stringify({ "hermes.pricing": example }, null, 2) + "\n```",
    );
  }
  return out.join("\n\n") + "\n";
}
