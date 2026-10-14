// Skills gallery (phase 6): a window onto `hermes skills`. Hermes owns the registries, the security scan and the
// install location; the IDE only runs its CLI, parses the answer and asks the user before anything is installed or
// removed. Every value that reaches the command line is validated first, because a .cmd shim would run it in a shell.
import type { InstalledSkillView as InstalledSkill, SkillHitView as SkillHit } from "../shared/protocol";
import { needsShell } from "./hermesLocator";
import { runHermes, type RunResult } from "./hermesMaintenance";

export type { InstalledSkill, SkillHit };


const SKILL_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._@:-]*(?:\/[A-Za-z0-9][A-Za-z0-9._@:-]*)*$/;
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SEARCH_QUERY = /^[\p{L}\p{N} ._-]{1,80}$/u;

export const isSkillIdentifier = (value: string) => value.length <= 200 && SKILL_IDENTIFIER.test(value);
export const isSkillName = (value: string) => SKILL_NAME.test(value);
export const isSearchQuery = (value: string) => SEARCH_QUERY.test(value.trim());

/** The JSON array `hermes skills search --json` prints (anything printed around it is ignored). */
export function parseSearchResults(output: string): SkillHit[] {
  const start = output.indexOf("[");
  const end = output.lastIndexOf("]");
  if (start < 0 || end < start) return [];
  let rows: unknown;
  try {
    rows = JSON.parse(output.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  const hits: SkillHit[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const identifier = typeof r.identifier === "string" ? r.identifier : "";
    if (!isSkillIdentifier(identifier)) continue; // never offer something that could not be installed safely
    hits.push({
      name: typeof r.name === "string" && r.name ? r.name : identifier.split("/").pop()!,
      identifier,
      source: typeof r.source === "string" ? r.source : "",
      trust: typeof r.trust_level === "string" ? r.trust_level : "",
      description: typeof r.description === "string" ? r.description : "",
    });
  }
  return hits;
}

/** The table `hermes skills list` prints: │ Name │ Category │ Source │ Trust │ Status │ */
export function parseInstalledSkills(output: string): InstalledSkill[] {
  const skills: InstalledSkill[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith("│")) continue;
    const cells = line.split("│").slice(1, -1).map((c) => c.trim());
    if (cells.length < 5 || !cells[0] || cells[0] === "Name") continue;
    skills.push({ name: cells[0], category: cells[1], source: cells[2], trust: cells[3], enabled: /^enabled/i.test(cells[4]) });
  }
  return skills;
}

export interface SkillsContext {
  /** Path to the hermes executable. */
  hermes: string;
  /** Hermes home the IDE's Hermes uses, so a skill lands where that Hermes will look for it. */
  home: string;
  env?: NodeJS.ProcessEnv;
}

function run(ctx: SkillsContext, args: string[], timeoutMs: number): Promise<RunResult> {
  const env = { ...(ctx.env ?? process.env), HERMES_HOME: ctx.home, COLUMNS: "220", NO_COLOR: "1", PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" };
  // Every argument was validated to hold no quote or shell metacharacter; a .cmd shim gets one command string, so quote the spaces.
  const quoted = needsShell(ctx.hermes) ? args.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : args;
  return runHermes(ctx.hermes, ["skills", ...quoted], { env, timeoutMs });
}

export async function searchSkills(ctx: SkillsContext, query: string, limit = 20): Promise<{ ok: boolean; hits: SkillHit[]; error?: string }> {
  if (!isSearchQuery(query)) return { ok: false, hits: [], error: "invalid query" };
  const result = await run(ctx, ["search", query.trim(), "--limit", String(Math.min(Math.max(limit, 1), 50)), "--json"], 60_000);
  if (result.code !== 0) return { ok: false, hits: [], error: failure(result) };
  return { ok: true, hits: parseSearchResults(result.output) };
}

export async function listInstalledSkills(ctx: SkillsContext): Promise<{ ok: boolean; skills: InstalledSkill[]; error?: string }> {
  const result = await run(ctx, ["list"], 60_000);
  if (result.code !== 0) return { ok: false, skills: [], error: failure(result) };
  return { ok: true, skills: parseInstalledSkills(result.output) };
}

/** Hermes' preview of a skill, as text. Nothing is installed. */
export async function inspectSkill(ctx: SkillsContext, identifier: string): Promise<{ ok: boolean; text: string }> {
  if (!isSkillIdentifier(identifier)) return { ok: false, text: "invalid identifier" };
  const result = await run(ctx, ["inspect", identifier], 60_000);
  return { ok: result.code === 0, text: result.output.trim() };
}

/** Installs through Hermes' own scanner; a blocked verdict stays blocked (the IDE never passes --force). */
export async function installSkill(ctx: SkillsContext, identifier: string): Promise<{ ok: boolean; output: string }> {
  if (!isSkillIdentifier(identifier)) return { ok: false, output: "invalid identifier" };
  const result = await run(ctx, ["install", identifier, "--yes"], 5 * 60_000);
  return { ok: result.code === 0 && /\bInstalled:/i.test(result.output), output: result.output.trim() };
}

export async function uninstallSkill(ctx: SkillsContext, name: string): Promise<{ ok: boolean; output: string }> {
  if (!isSkillName(name)) return { ok: false, output: "invalid name" };
  const result = await run(ctx, ["uninstall", name, "--yes"], 60_000);
  return { ok: result.code === 0, output: result.output.trim() };
}

function failure(result: RunResult): string {
  return result.timedOut ? "timed out" : result.output.trim().split(/\r?\n/).slice(-3).join(" ").slice(0, 300) || `exit code ${result.code}`;
}
