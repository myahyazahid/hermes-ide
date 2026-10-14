// Hermes' curated memory (phase 6): MEMORY.md (notes about the project and the agent's own lessons) and USER.md
// (who the user is). The agent reads both at the start of every session, so what is written here shapes every
// answer. The format is Hermes' own (tools/memory_tool_store.py): entries joined by "\n§\n", stripped, no empty
// ones, written without a BOM. Anything else counts as "drift" and makes Hermes refuse its own memory writes, so
// this module only ever writes exactly that shape.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { parse } from "yaml";
import type { MemoryTarget, MemoryTargetView } from "../shared/protocol";

export type { MemoryTarget, MemoryTargetView };

export const ENTRY_DELIMITER = "\n§\n";
export const DEFAULT_LIMITS = { memory: 2200, user: 1375 } as const;

export const MEMORY_TARGETS: readonly MemoryTarget[] = ["memory", "user"];
const FILE_NAMES: Record<MemoryTarget, string> = { memory: "MEMORY.md", user: "USER.md" };

export interface MemoryConfig {
  limits: Record<MemoryTarget, number>;
  /** Hermes lets the user switch either file off in config.yaml (memory.memory_enabled / user_profile_enabled). */
  enabled: Record<MemoryTarget, boolean>;
}

export interface MemoryView {
  home: string;
  targets: MemoryTargetView[];
}

export type SaveResult =
  | { ok: true; view: MemoryTargetView }
  | { ok: false; reason: "changed" | "tooLong" | "entryTooLong" | "write"; message?: string; view: MemoryTargetView };

export function memoryDir(home: string): string {
  return path.join(home, "memories");
}

export function memoryPath(home: string, target: MemoryTarget): string {
  return path.join(memoryDir(home), FILE_NAMES[target]);
}

/** Entries as Hermes parses them: split on the full delimiter (a bare "§" survives), stripped, empty ones dropped. */
export function parseEntries(raw: string): string[] {
  return raw.replace(/^﻿/, "").split(ENTRY_DELIMITER).map((e) => e.trim()).filter(Boolean);
}

/** What the user typed, made safe to store: split on the delimiter, stripped, empty ones dropped. */
export function normalizeEntries(entries: string[]): string[] {
  return entries.flatMap((e) => e.split(ENTRY_DELIMITER)).map((e) => e.trim()).filter(Boolean);
}

export function serializeEntries(entries: string[]): string {
  return normalizeEntries(entries).join(ENTRY_DELIMITER);
}

export function usedChars(entries: string[]): number {
  return serializeEntries(entries).length;
}

/** Reads the `memory:` section of config.yaml; anything missing or malformed falls back to Hermes' defaults. */
export function memoryConfig(configYaml: string | undefined): MemoryConfig {
  let section: Record<string, unknown> = {};
  try {
    const doc = configYaml ? parse(configYaml) : undefined;
    const raw = doc && typeof doc === "object" ? (doc as Record<string, unknown>).memory : undefined;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) section = raw as Record<string, unknown>;
  } catch {
    // an unreadable config: use the defaults, like Hermes does
  }
  const limit = (key: string, fallback: number) => {
    const v = Number(section[key]);
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
  };
  const flag = (key: string) => {
    const v = section[key];
    if (typeof v === "string") return !["false", "0", "no", "off"].includes(v.trim().toLowerCase());
    return v === undefined || v === null ? true : !!v;
  };
  return {
    limits: { memory: limit("memory_char_limit", DEFAULT_LIMITS.memory), user: limit("user_char_limit", DEFAULT_LIMITS.user) },
    enabled: { memory: flag("memory_enabled"), user: flag("user_profile_enabled") },
  };
}

const fingerprint = (raw: string | undefined) => createHash("sha1").update(raw ?? "\u0000missing").digest("hex").slice(0, 16);

function readRaw(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function targetView(home: string, target: MemoryTarget, config: MemoryConfig, raw: string | undefined): MemoryTargetView {
  const entries = parseEntries(raw ?? "");
  return {
    target,
    path: memoryPath(home, target),
    entries,
    limit: config.limits[target],
    used: usedChars(entries),
    enabled: config.enabled[target],
    hash: fingerprint(raw),
    irregular: raw !== undefined && raw.replace(/^﻿/, "").trim() !== entries.join(ENTRY_DELIMITER),
  };
}

export function loadMemory(home: string, configYaml: string | undefined): MemoryView {
  const config = memoryConfig(configYaml);
  return { home, targets: MEMORY_TARGETS.map((t) => targetView(home, t, config, readRaw(memoryPath(home, t)))) };
}

/**
 * Replaces one memory file with `entries`. Refuses when the file changed since `expectedHash` was read (the agent
 * may have saved a lesson meanwhile) or when the text would not fit Hermes' budget, and keeps the previous file as
 * `<name>.hermes-ide-bak` so a bad edit is recoverable.
 */
export function saveMemory(home: string, configYaml: string | undefined, target: MemoryTarget, entries: string[], expectedHash: string): SaveResult {
  const config = memoryConfig(configYaml);
  const file = memoryPath(home, target);
  const current = readRaw(file);
  const view = targetView(home, target, config, current);
  if (view.hash !== expectedHash) return { ok: false, reason: "changed", view };
  const clean = normalizeEntries(entries);
  const limit = config.limits[target];
  if (clean.some((e) => e.length > limit)) return { ok: false, reason: "entryTooLong", view };
  if (usedChars(clean) > limit) return { ok: false, reason: "tooLong", view };
  const text = clean.join(ENTRY_DELIMITER);
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    if (current !== undefined && existsSync(file)) copyFileSync(file, `${file}.hermes-ide-bak`);
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, text, "utf8");
    renameSync(temp, file);
  } catch (error) {
    return { ok: false, reason: "write", message: (error as Error).message, view };
  }
  return { ok: true, view: targetView(home, target, config, text) };
}
