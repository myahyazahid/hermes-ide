// Session bar with a Claude-style history popover (F-14): current title, search, resume, delete.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { SessionView, TranscriptItem, ViewState } from "../../src/shared/protocol";
import { compactTime } from "../../src/core/time";
import { formatMoney, formatTokenCount } from "../../src/core/usage";
import { t, type Locale } from "../../src/shared/strings";
import { send } from "./host";

interface Props {
  state: ViewState;
  locale: Locale;
  items: TranscriptItem[];
  sessions: { requestId: number; sessions: SessionView[] } | undefined;
}

let nextRequestId = 1;

/** Hermes titles a session after its first turn; until then use the first message, like Claude does. */
function currentTitle(state: ViewState, items: TranscriptItem[], locale: Locale): string {
  if (state.sessionTitle) return state.sessionTitle;
  const first = items.find((i) => i.kind === "user");
  if (first && first.kind === "user") return first.text.split("\n")[0].slice(0, 80);
  return t(locale, "sessions.new");
}

export function SessionBar({ state, locale, items, sessions }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [requestId, setRequestId] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);

  const loaded = sessions && sessions.requestId === requestId ? sessions.sessions : undefined;
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (loaded ?? []).slice().sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    return q ? list.filter((s) => (s.title || t(locale, "sessions.untitled")).toLowerCase().includes(q)) : list;
  }, [loaded, query, locale]);

  const refresh = () => {
    const id = nextRequestId++;
    setRequestId(id);
    send({ type: "listSessions", requestId: id });
  };

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    setQuery("");
    setActive(0);
    refresh();
    requestAnimationFrame(() => search.current?.focus());
  };

  const choose = (s: SessionView) => {
    setOpen(false);
    if (!s.current) send({ type: "openSession", id: s.id, title: s.title || undefined });
  };

  // The composer's "/" menu opens the history through a window event.
  useEffect(() => {
    const show = () => {
      if (!open) toggle();
    };
    window.addEventListener("hermes:history", show);
    return () => window.removeEventListener("hermes:history", show);
  });

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (shown.length) setActive((a) => (a + (e.key === "ArrowDown" ? 1 : shown.length - 1)) % shown.length);
    } else if (e.key === "Enter" && shown[active]) {
      e.preventDefault();
      choose(shown[active]);
    }
  };

  const title = currentTitle(state, items, locale);
  const canUse = state.phase === "ready" || state.phase === "stopped";

  return (
    <div className="session-bar" ref={root}>
      <span className="session-title" title={title}>{title}</span>
      {state.learning?.on && (
        <button type="button" className="session-chip learning" title={t(locale, "learning.chipTooltip")} onClick={() => send({ type: "setLearning", on: false })}>
          🎓 {t(locale, "learning.chip")}
        </button>
      )}
      {state.privacy?.localOnly && (
        <button
          type="button"
          className={`session-chip local${state.privacy.blocked ? " blocked" : ""}`}
          title={state.privacy.blocked ? t(locale, "privacy.blocked", state.privacy.blocked) : t(locale, "privacy.badgeTooltip")}
          onClick={() => send({ type: "showPrivacy" })}
        >
          🔒 {t(locale, "privacy.badge")}
        </button>
      )}
      {state.rules && (
        <button
          type="button"
          className="session-chip rules"
          title={t(locale, "rules.chipTitle", state.rules.files.join(", ")) + (state.rules.truncated ? `\n${t(locale, "rules.truncated")}` : "")}
          onClick={() => send({ type: "openRules" })}
        >
          § {t(locale, "rules.chip")}
          {state.rules.truncated ? " ⚠" : ""}
        </button>
      )}
      {state.sessionUsage && <UsageChip usage={state.sessionUsage} locale={locale} />}
      <button
        type="button"
        className="icon"
        title={t(locale, "action.newSession")}
        aria-label={t(locale, "action.newSession")}
        disabled={!canUse || state.busy}
        onClick={() => send({ type: "newSession" })}
      >
        <NewChatIcon />
      </button>
      <button
        type="button"
        className={`icon${open ? " on" : ""}`}
        title={t(locale, "sessions.history")}
        aria-label={t(locale, "sessions.history")}
        aria-expanded={open}
        disabled={!canUse}
        onClick={toggle}
      >
        <ClockIcon />
      </button>
      {open && (
        <div className="history" role="dialog" aria-label={t(locale, "sessions.history")} onKeyDown={onKeyDown}>
          <div className="history-search">
            <SearchIcon />
            <input
              ref={search}
              value={query}
              placeholder={t(locale, "sessions.search")}
              aria-label={t(locale, "sessions.search")}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
            />
          </div>
          <ul className="history-list" role="listbox">
            {!loaded && <li className="history-note">{t(locale, "sessions.loading")}</li>}
            {loaded && shown.length === 0 && <li className="history-note">{t(locale, query ? "sessions.noMatch" : "sessions.empty")}</li>}
            {shown.map((s, i) => {
              const label = s.title || t(locale, "sessions.untitled");
              return (
                <li key={s.id} role="option" aria-selected={i === active} className={`${i === active ? "on" : ""}${s.current ? " current" : ""}`}>
                  <button type="button" className="history-open" title={label} onMouseEnter={() => setActive(i)} onClick={() => choose(s)}>
                    <span className="history-title">{label}</span>
                    <span className="history-when">
                      {s.current && state.busy ? <span className="spinner" aria-label={t(locale, "sessions.running")} /> : compactTime(s.updatedAt, locale)}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="history-delete"
                    title={t(locale, "sessions.delete")}
                    aria-label={`${t(locale, "sessions.delete")}: ${label}`}
                    onClick={() => {
                      const id = nextRequestId++;
                      setRequestId(id);
                      send({ type: "deleteSession", id: s.id, title: label, requestId: id });
                    }}
                  >
                    <TrashIcon />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

function UsageChip({ usage, locale }: { usage: NonNullable<ViewState["sessionUsage"]>; locale: Locale }) {
  const cost = usage.cost === undefined ? "" : formatMoney(usage.cost, usage.currency);
  const costNote = usage.cost === undefined ? "" : t(locale, usage.unpriced ? "usageSession.costPartial" : "usageSession.cost", cost);
  const title = t(locale, "usageSession.title", formatTokenCount(usage.input), formatTokenCount(usage.output), usage.turns, costNote);
  return (
    <button type="button" className="session-chip usage" title={title} onClick={() => send({ type: "showUsage" })}>
      ↑{formatTokenCount(usage.input)} ↓{formatTokenCount(usage.output)}
      {cost && <span className="cost"> · {usage.unpriced ? `≈${cost}+` : `≈${cost}`}</span>}
    </button>
  );
}

function NewChatIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
      <path d="M8 3.2v9.6M3.2 8h9.6" strokeLinecap="round" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M8 4.6V8l2.3 1.5" strokeLinecap="round" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
      <circle cx="7" cy="7" r="4.6" />
      <path d="M10.4 10.4 14 14" strokeLinecap="round" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
      <path d="M2.5 4h11M6 4V2.6h4V4M4 4l.7 9.4h6.6L12 4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
