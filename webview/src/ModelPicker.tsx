// Model picker popover: search, recent models, provider groups, readable names over raw ids.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { ModelOption, ViewState } from "../../src/shared/protocol";
import { t, type Locale } from "../../src/shared/strings";
import { prettyModelName } from "./format";

const RECENT_KEY = "hermes.recentModels";
const RECENT_MAX = 4;

function readRecent(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function rememberRecent(id: string): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...readRecent().filter((r) => r !== id)].slice(0, RECENT_MAX)));
  } catch {
    // Storage can be unavailable; recents are only a convenience.
  }
}

type Section = { title: string; models: ModelOption[] };

interface Props {
  state: ViewState;
  locale: Locale;
  onPick(id: string): void;
  onClose(): void;
}

export function ModelPicker({ state, locale, onPick, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    requestAnimationFrame(() => search.current?.focus());
  }, []);

  const sections = useMemo<Section[]>(() => {
    const q = query.trim().toLowerCase();
    const matches = (m: ModelOption) =>
      !q || [m.label, m.id, m.group, prettyModelName(m.label).name].some((s) => s.toLowerCase().includes(q));
    const models = state.models.filter(matches);
    const out: Section[] = [];
    if (!q && state.models.length > 6) {
      const recent = readRecent()
        .map((id) => state.models.find((m) => m.id === id))
        .filter((m): m is ModelOption => !!m);
      if (recent.length) out.push({ title: t(locale, "model.recent"), models: recent });
    }
    const groups = new Map<string, ModelOption[]>();
    for (const m of models) groups.set(m.group, [...(groups.get(m.group) ?? []), m]);
    for (const [group, items] of groups) out.push({ title: group || "Hermes", models: items });
    return out;
  }, [state.models, query, locale]);

  const rows = sections.flatMap((s) => s.models);
  const current = Math.min(active, Math.max(rows.length - 1, 0));

  // Start on the active model so Enter/arrows feel anchored.
  useEffect(() => {
    if (query) return;
    const i = rows.findIndex((m) => m.id === state.currentModelId);
    if (i >= 0) setActive(i);
    // Only when the picker opens or the list resets.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query === ""]);

  useEffect(() => {
    list.current?.querySelector(`[data-row="${current}"]`)?.scrollIntoView({ block: "nearest" });
  }, [current]);

  const pick = (m: ModelOption) => {
    rememberRecent(m.id);
    onPick(m.id);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (rows.length) setActive((current + (e.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (rows[current]) pick(rows[current]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  let index = -1;
  return (
    <div className="picker" role="dialog" aria-label={t(locale, "model.title")} onKeyDown={onKeyDown} onMouseDown={(e) => e.target !== search.current && e.preventDefault()}>
      <div className="picker-head">
        <span className="picker-title">{t(locale, "model.title")}</span>
        <span className="picker-count">{t(locale, "model.count", state.models.length)}</span>
      </div>
      <div className="picker-search">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
          <circle cx="7" cy="7" r="4.6" />
          <path d="M10.4 10.4 14 14" strokeLinecap="round" />
        </svg>
        <input
          ref={search}
          value={query}
          placeholder={t(locale, "model.search")}
          aria-label={t(locale, "model.search")}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
        />
      </div>
      <div className="picker-list" ref={list} role="listbox">
        {rows.length === 0 && <div className="picker-empty">{t(locale, "model.none")}</div>}
        {sections.map((section) => (
          <div key={section.title} className="picker-section">
            <div className="picker-section-title">{section.title}</div>
            {section.models.map((m) => {
              index++;
              const i = index;
              const { name, date } = prettyModelName(m.label);
              const selected = m.id === state.currentModelId;
              return (
                <button
                  key={`${section.title}:${m.id}`}
                  type="button"
                  role="option"
                  data-row={i}
                  aria-selected={selected}
                  className={`picker-row${i === current ? " on" : ""}${selected ? " selected" : ""}${m.blocked ? " blocked" : ""}`}
                  title={m.blocked ? t(locale, "privacy.modelLocked") : m.id}
                  aria-disabled={m.blocked || undefined}
                  onMouseMove={() => i !== current && setActive(i)}
                  onClick={() => !m.blocked && pick(m)}
                >
                  <span className="picker-mark" aria-hidden />
                  <span className="picker-text">
                    <span className="picker-name">{name}</span>
                    <span className="picker-id">
                      {m.label}
                      {date && <span className="picker-date"> · {formatDate(date, locale)}</span>}
                    </span>
                  </span>
                  {m.blocked && <span className="picker-lock" aria-hidden>🔒</span>}
                  {selected && (
                    <svg className="picker-check" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
                      <path d="m3.5 8.5 3 3 6-7" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <div className="picker-foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> {t(locale, "model.navigate")}</span>
        <span><kbd>Enter</kbd> {t(locale, "model.choose")}</span>
        <span><kbd>Esc</kbd> {t(locale, "model.close")}</span>
      </div>
    </div>
  );
}

function formatDate(yyyymmdd: string, locale: Locale): string {
  const d = new Date(Date.UTC(+yyyymmdd.slice(0, 4), +yyyymmdd.slice(4, 6) - 1, +yyyymmdd.slice(6, 8)));
  return Number.isNaN(d.getTime()) ? yyyymmdd : d.toLocaleDateString(locale === "id" ? "id-ID" : "en-US", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/** The composer bar's model button: readable name of the current model. */
export function currentModelName(state: ViewState): string | undefined {
  const m = state.models.find((o) => o.id === state.currentModelId);
  return m ? prettyModelName(m.label).name : undefined;
}
