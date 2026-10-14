// Token and cost tracking (phase 5). Hermes reports exact token counts per turn in the ACP prompt response, so this
// only aggregates them. Cost is an estimate from prices the user enters (USD per million tokens by default); the
// IDE never guesses prices. No VS Code or Node imports: the host persists the ledger and the webview formats it.

export interface TokenUsage {
  input: number;
  output: number;
  /** Reasoning tokens. Providers count them inside `output`, so they are informational and never billed twice. */
  thought: number;
  /** Prompt tokens served from the provider's cache. Counted inside `input`. */
  cachedRead: number;
}

export interface Price {
  /** Per million input tokens. */
  input: number;
  /** Per million output tokens. */
  output: number;
  /** Per million cached input tokens; defaults to `input` (no discount assumed). */
  cachedInput?: number;
}

export type PricingTable = Record<string, Price>;

export const NO_USAGE: TokenUsage = { input: 0, output: 0, thought: 0, cachedRead: 0 };

export interface Bucket extends TokenUsage {
  turns: number;
}

/** What gets persisted: per day by profile and model, and per session by model. */
export interface Ledger {
  v: 1;
  days: Record<string, Record<string, Record<string, Bucket>>>;
  sessions: Record<string, { profileId: string; updatedAt: number; models: Record<string, Bucket> }>;
}

export interface UsageRecord {
  at: number;
  sessionId: string;
  profileId: string;
  model: string;
  usage: TokenUsage;
}

export function emptyLedger(): Ledger {
  return { v: 1, days: {}, sessions: {} };
}

const count = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n) : 0);

/** ACP `Usage` (camelCase, optional extras) -> ours. Returns undefined when Hermes reported nothing countable. */
export function fromAcpUsage(u: { inputTokens?: number | null; outputTokens?: number | null; thoughtTokens?: number | null; cachedReadTokens?: number | null } | null | undefined): TokenUsage | undefined {
  if (!u) return undefined;
  const usage = { input: count(u.inputTokens), output: count(u.outputTokens), thought: count(u.thoughtTokens), cachedRead: count(u.cachedReadTokens) };
  return usage.input || usage.output ? usage : undefined;
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return { input: a.input + b.input, output: a.output + b.output, thought: a.thought + b.thought, cachedRead: a.cachedRead + b.cachedRead };
}

function addToBucket(bucket: Bucket | undefined, usage: TokenUsage): Bucket {
  return { ...addUsage(bucket ?? { ...NO_USAGE }, usage), turns: (bucket?.turns ?? 0) + 1 };
}

/** Local calendar day, `YYYY-MM-DD`. */
export function dayKey(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Adds one turn to the ledger (returns a new object; the input is not modified). */
export function recordUsage(ledger: Ledger, rec: UsageRecord): Ledger {
  const day = dayKey(rec.at);
  const days = { ...ledger.days };
  const byProfile = { ...(days[day] ?? {}) };
  const byModel = { ...(byProfile[rec.profileId] ?? {}) };
  byModel[rec.model] = addToBucket(byModel[rec.model], rec.usage);
  byProfile[rec.profileId] = byModel;
  days[day] = byProfile;

  const prev = ledger.sessions[rec.sessionId];
  const models = { ...(prev?.models ?? {}) };
  models[rec.model] = addToBucket(models[rec.model], rec.usage);
  const sessions = { ...ledger.sessions, [rec.sessionId]: { profileId: rec.profileId, updatedAt: rec.at, models } };
  return { v: 1, days, sessions };
}

/** Keeps the newest `maxDays` days and `maxSessions` sessions so the persisted ledger stays small. */
export function pruneLedger(ledger: Ledger, opts: { maxDays?: number; maxSessions?: number } = {}): Ledger {
  const { maxDays = 120, maxSessions = 200 } = opts;
  const dayKeys = Object.keys(ledger.days).sort().slice(-maxDays);
  const days = Object.fromEntries(dayKeys.map((k) => [k, ledger.days[k]]));
  const sessionIds = Object.entries(ledger.sessions)
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    .slice(0, maxSessions)
    .map(([id]) => id);
  const sessions = Object.fromEntries(sessionIds.map((id) => [id, ledger.sessions[id]]));
  return { v: 1, days, sessions };
}

/** Accepts only well-formed entries from the `hermes.pricing` setting; ignores the rest. */
export function parsePricing(raw: unknown): PricingTable {
  const table: PricingTable = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return table;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
  for (const [model, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const v = value as Record<string, unknown>;
    const input = num(v.input);
    const output = num(v.output);
    if (input === undefined || output === undefined) continue;
    const cachedInput = num(v.cachedInput);
    table[model] = cachedInput === undefined ? { input, output } : { input, output, cachedInput };
  }
  return table;
}

/**
 * Finds the price for a model id. Exact match first, then the id without its provider prefix
 * ("anthropic/claude-x" or "custom:host:claude-x" match an entry named "claude-x"), then the longest entry the id ends with.
 */
export function priceFor(model: string | undefined, table: PricingTable): Price | undefined {
  if (!model) return undefined;
  const id = model.toLowerCase();
  const entries = Object.entries(table).map(([k, v]) => [k.toLowerCase(), v] as const);
  const exact = entries.find(([k]) => k === id);
  if (exact) return exact[1];
  const bare = id.split(/[/:]/).pop() ?? id;
  const byBare = entries.find(([k]) => k === bare);
  if (byBare) return byBare[1];
  return entries.filter(([k]) => id.endsWith(k)).sort((a, b) => b[0].length - a[0].length)[0]?.[1];
}

/** Estimated cost in the unit the prices were entered in. Cached prompt tokens use `cachedInput` when given. */
export function costOf(usage: TokenUsage, price: Price): number {
  const cached = Math.min(usage.cachedRead, usage.input);
  const fresh = usage.input - cached;
  const cachedPrice = price.cachedInput ?? price.input;
  return (fresh * price.input + cached * cachedPrice + usage.output * price.output) / 1_000_000;
}

export interface Totals {
  usage: TokenUsage;
  turns: number;
  /** Sum over models that have a price; undefined when none do. */
  cost?: number;
  /** Models used but missing from the pricing table (their tokens are not in `cost`). */
  unpriced: string[];
}

function totalOf(buckets: Record<string, Bucket>, pricing: PricingTable): Totals {
  let usage = { ...NO_USAGE };
  let turns = 0;
  let cost: number | undefined;
  const unpriced: string[] = [];
  for (const [model, b] of Object.entries(buckets)) {
    usage = addUsage(usage, b);
    turns += b.turns;
    const price = priceFor(model, pricing);
    if (price) cost = (cost ?? 0) + costOf(b, price);
    else unpriced.push(model);
  }
  return { usage, turns, cost, unpriced };
}

export function sessionTotals(ledger: Ledger, sessionId: string | undefined, pricing: PricingTable): Totals | undefined {
  const s = sessionId ? ledger.sessions[sessionId] : undefined;
  return s ? totalOf(s.models, pricing) : undefined;
}

export interface UsageRow {
  profileId: string;
  model: string;
  usage: TokenUsage;
  turns: number;
  cost?: number;
}

/** Usage per profile and model for days in [fromDay, toDay] (inclusive `YYYY-MM-DD` keys). */
export function rangeRows(ledger: Ledger, fromDay: string, toDay: string, pricing: PricingTable): UsageRow[] {
  const merged = new Map<string, UsageRow>();
  for (const [day, byProfile] of Object.entries(ledger.days)) {
    if (day < fromDay || day > toDay) continue;
    for (const [profileId, byModel] of Object.entries(byProfile)) {
      for (const [model, b] of Object.entries(byModel)) {
        const key = `${profileId}\u0000${model}`;
        const row = merged.get(key) ?? { profileId, model, usage: { ...NO_USAGE }, turns: 0 };
        row.usage = addUsage(row.usage, b);
        row.turns += b.turns;
        merged.set(key, row);
      }
    }
  }
  return [...merged.values()]
    .map((row) => {
      const price = priceFor(row.model, pricing);
      return price ? { ...row, cost: costOf(row.usage, price) } : row;
    })
    .sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0) || b.usage.input + b.usage.output - (a.usage.input + a.usage.output));
}

/** "1.2k", "3.4M"; small numbers as-is. */
export function formatTokenCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1).replace(/\.?0+$/, "")}M`;
}

/** Money with enough digits to matter for small amounts: 0.0042 -> "0.0042", 12.3 -> "12.30". */
export function formatMoney(amount: number, currency: string): string {
  const digits = amount === 0 ? 2 : amount < 0.01 ? 4 : amount < 1 ? 3 : 2;
  return `${currency}${amount.toFixed(digits)}`;
}
