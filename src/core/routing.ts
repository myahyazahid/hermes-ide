// Automatic model routing (phase 6): a cheap model for light questions, a strong one for heavy work, and a fallback
// model when the chosen one fails. The rules are plain and the reason is always shown, so the user can predict and
// overrule them: picking a model by hand pauses routing for that session.
import type { AgentMode } from "../shared/protocol";
import type { StringKey } from "../shared/strings";

export type RouteTier = "light" | "heavy";

export interface RoutingSettings {
  enabled: boolean;
  /** Model names or ids; empty means "keep whatever is selected". */
  lightModel: string;
  heavyModel: string;
  fallbackModel: string;
  /** A prompt longer than this is never light. */
  lightMaxChars: number;
}

export const DEFAULT_LIGHT_MAX_CHARS = 280;
/** Attached code above this size makes the request heavy: the model has a lot to read and reason about. */
export const HEAVY_CONTEXT_CHARS = 4000;

export interface RouteInput {
  text: string;
  mode: AgentMode;
  /** What was attached: kinds, and the size of inline text for files/selections where known. */
  context: { kind: "file" | "folder" | "selection" | "codebase" | "image"; chars?: number }[];
}

export interface RouteDecision {
  tier: RouteTier;
  reason: StringKey;
}

/** Words (Indonesian and English) that signal work needing the stronger model, whatever the length. */
const HEAVY_WORDS = new RegExp(
  "\\b(" + [
    "refactor\\w*", "migrat\\w*", "migrasi", "architect\\w*", "arsitektur", "redesign\\w*", "rancang\\w*", "design",
    "implement\\w*", "rewrite", "tulis ulang", "optimi[sz]\\w*", "debug\\w*", "investigat\\w*", "selidiki", "security",
    "keamanan", "multi-?file", "seluruh", "semua file", "across", "end-to-end", "concurren\\w*", "race condition",
  ].join("|") + ")\\b",
  "i",
);

/** Chooses the tier for one message. First matching rule wins; see the reasons. */
export function classifyPrompt(input: RouteInput, settings: Pick<RoutingSettings, "lightMaxChars">): RouteDecision {
  if (input.mode === "plan") return { tier: "heavy", reason: "routing.reason.plan" };
  const attached = input.context.reduce((n, c) => n + (c.chars ?? 0), 0);
  if (input.context.some((c) => c.kind === "folder" || c.kind === "codebase") || attached > HEAVY_CONTEXT_CHARS) {
    return { tier: "heavy", reason: "routing.reason.context" };
  }
  if (input.context.some((c) => c.kind === "image")) return { tier: "heavy", reason: "routing.reason.image" };
  if (input.text.trim().length > settings.lightMaxChars) return { tier: "heavy", reason: "routing.reason.long" };
  if (HEAVY_WORDS.test(input.text)) return { tier: "heavy", reason: "routing.reason.keyword" };
  return { tier: "light", reason: "routing.reason.short" };
}

export interface ModelChoice {
  modelId: string;
  name: string;
}

/** The ACP model id for the model the user named for a tier, or undefined when it is unset or not offered. */
export function modelForTier(settings: RoutingSettings, tier: RouteTier, available: ModelChoice[], resolve: (available: ModelChoice[], wanted: string) => string | undefined): string | undefined {
  const wanted = tier === "light" ? settings.lightModel : settings.heavyModel;
  return wanted.trim() ? resolve(available, wanted) : undefined;
}

/** Provider failures where trying another model can help (a model that is rate limited, out of credits, rejecting the key, or down). */
export function worthFallback(status: number): boolean {
  return status === 401 || status === 402 || status === 403 || status === 404 || status === 408 || status === 429 || status >= 500;
}

export function parseRoutingSettings(raw: { enabled?: unknown; lightModel?: unknown; heavyModel?: unknown; fallbackModel?: unknown; lightMaxChars?: unknown }): RoutingSettings {
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const max = typeof raw.lightMaxChars === "number" && Number.isFinite(raw.lightMaxChars) ? Math.round(raw.lightMaxChars) : DEFAULT_LIGHT_MAX_CHARS;
  return {
    enabled: raw.enabled === true,
    lightModel: text(raw.lightModel),
    heavyModel: text(raw.heavyModel),
    fallbackModel: text(raw.fallbackModel),
    lightMaxChars: Math.min(Math.max(max, 20), 4000),
  };
}
