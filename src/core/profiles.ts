// Endpoint profiles (F-16): several named custom endpoints ("VPS vLLM", "OpenRouter") next to the
// built-in "Hermes config" profile. Only non-secret fields live here; each profile's API key is in
// SecretStorage under its own key, and only the active profile's key reaches Hermes.
import type { CustomEndpoint } from "./endpoint";

export const HERMES_PROFILE_ID = "hermes";

export interface EndpointProfile {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  contextLength?: number;
}

export function secretKeyFor(profileId: string): string {
  return `hermes.profile.${profileId}.apiKey`;
}

/** The secret key used before profiles existed (Phase 1). */
export const LEGACY_SECRET_KEY = "hermes.endpoint.apiKey";

export function newProfileId(name: string, existing: Iterable<string>): string {
  const taken = new Set([HERMES_PROFILE_ID, ...existing]);
  const base = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "profile";
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

export function sanitizeProfiles(raw: unknown): EndpointProfile[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: EndpointProfile[] = [];
  for (const p of raw) {
    if (!p || typeof p !== "object") continue;
    const r = p as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id.trim() : "";
    if (!id || id === HERMES_PROFILE_ID || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: typeof r.name === "string" && r.name.trim() ? r.name.trim() : id,
      baseUrl: typeof r.baseUrl === "string" ? r.baseUrl.trim() : "",
      model: typeof r.model === "string" ? r.model.trim() : "",
      contextLength: typeof r.contextLength === "number" && r.contextLength > 0 ? Math.floor(r.contextLength) : undefined,
    });
  }
  return out;
}

export function toEndpoint(profile: EndpointProfile, apiKey?: string): CustomEndpoint {
  return { baseUrl: profile.baseUrl, model: profile.model, contextLength: profile.contextLength ?? 0, apiKey };
}

/**
 * Phase 1 stored one custom endpoint in `hermes.endpoint.*`. Turns it into a profile so existing
 * setups keep working; returns undefined when there is nothing to migrate.
 */
export function migrateLegacyEndpoint(legacy: {
  mode?: string;
  baseUrl?: string;
  model?: string;
  contextLength?: number;
}): { profile: EndpointProfile; active: boolean } | undefined {
  if (!legacy.baseUrl?.trim() || !legacy.model?.trim()) return undefined;
  return {
    profile: {
      id: "custom-api",
      name: "Custom API",
      baseUrl: legacy.baseUrl.trim(),
      model: legacy.model.trim(),
      contextLength: legacy.contextLength && legacy.contextLength > 0 ? legacy.contextLength : undefined,
    },
    active: legacy.mode === "custom",
  };
}
