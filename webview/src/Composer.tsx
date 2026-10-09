// Composer with context chips and @-mentions (F-12).
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { ContextRef, MentionItem, ViewState } from "../../src/shared/protocol";
import { t, type Locale } from "../../src/shared/strings";
import { formatTokens, relativePath } from "./format";
import { send } from "./host";

interface Props {
  state: ViewState;
  locale: Locale;
  inputRef: RefObject<HTMLTextAreaElement>;
  chips: ContextRef[];
  setChips(update: (prev: ContextRef[]) => ContextRef[]): void;
  mention: { requestId: number; items: MentionItem[] } | undefined;
}

let nextRequestId = 1;

export function chipLabel(ref: ContextRef, cwd?: string): string {
  if (ref.kind === "codebase") return "codebase";
  const name = ref.path.split(/[\\/]/).pop() ?? ref.path;
  if (ref.kind === "selection") return `${name} · ${ref.startLine}${ref.endLine && ref.endLine !== ref.startLine ? `-${ref.endLine}` : ""}`;
  const rel = relativePath(ref.path, cwd);
  return ref.kind === "folder" ? `${rel}/` : rel;
}

export function Composer({ state, locale, inputRef, chips, setChips, mention }: Props) {
  const [text, setText] = useState("");
  const [query, setQuery] = useState<{ value: string; start: number; requestId: number } | undefined>();
  const [active, setActive] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const canSend = !state.busy && ["ready", "stopped", "crashed"].includes(state.phase) && text.trim().length > 0;
  const results = query && mention?.requestId === query.requestId ? mention.items : undefined;

  const submit = useCallback(() => {
    if (!canSend) return;
    send({ type: "send", text, context: chips });
    setText("");
    setChips(() => []);
    setQuery(undefined);
  }, [canSend, text, chips, setChips]);

  // Auto-grow up to a limit.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text, inputRef]);

  const updateMention = (value: string, caret: number) => {
    const m = /(^|\s)@([^\s@]*)$/.exec(value.slice(0, caret));
    if (!m) {
      setQuery(undefined);
      return;
    }
    const requestId = nextRequestId++;
    setQuery({ value: m[2], start: caret - m[2].length - 1, requestId });
    setActive(0);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => send({ type: "mentionQuery", requestId, query: m[2] }), 60);
  };

  const pick = (item: MentionItem) => {
    if (!query) return;
    const el = inputRef.current;
    const caret = el?.selectionStart ?? text.length;
    const next = text.slice(0, query.start) + text.slice(caret);
    setText(next);
    setChips((prev) => (prev.some((c) => c.kind === item.kind && c.path === item.path) ? prev : [...prev, { kind: item.kind, path: item.path }]));
    setQuery(undefined);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(query.start, query.start);
    });
  };

  return (
    <div className="composer">
      {results && (
        <ul className="mentions" role="listbox" aria-label="@">
          {results.length === 0 && <li className="empty">{t(locale, "composer.noMatches")}</li>}
          {results.map((item, i) => (
            <li key={item.kind + item.path} role="option" aria-selected={i === active}>
              <button type="button" className={i === active ? "on" : ""} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(item)}>
                <span className="mention-icon" aria-hidden>{item.kind === "folder" ? "▸" : item.kind === "codebase" ? "✦" : "·"}</span>
                <span className="mono">{item.label}</span>
                {item.kind === "codebase" && <span className="muted mention-note">{t(locale, "index.mention")}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {chips.length > 0 && (
        <div className="chips">
          {chips.map((c, i) => {
            const label = chipLabel(c, state.cwd);
            return (
              <span key={`${c.kind}:${c.path}:${c.startLine ?? ""}`} className={`chip ${c.kind}`} title={c.path}>
                <span className="mono">{c.kind === "folder" ? "▸ " : c.kind === "codebase" ? "✦ " : ""}{label}</span>
                <button type="button" aria-label={t(locale, "composer.removeChip", label)} onClick={() => setChips((prev) => prev.filter((_, j) => j !== i))}>
                  ×
                </button>
              </span>
            );
          })}
        </div>
      )}
      <textarea
        ref={inputRef}
        value={text}
        rows={2}
        placeholder={`${t(locale, "composer.placeholder")} ${t(locale, "composer.mentionHint")}`}
        aria-label={t(locale, "composer.placeholder")}
        aria-autocomplete="list"
        onChange={(e) => {
          setText(e.target.value);
          updateMention(e.target.value, e.target.selectionStart ?? e.target.value.length);
        }}
        onKeyDown={(e) => {
          if (results?.length) {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => (a + (e.key === "ArrowDown" ? 1 : results.length - 1)) % results.length);
              return;
            }
            if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault();
              pick(results[Math.min(active, results.length - 1)]);
              return;
            }
          }
          if (e.key === "Escape" && query) {
            e.preventDefault();
            setQuery(undefined);
          } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          } else if (e.key === "Escape" && state.busy) {
            e.preventDefault();
            send({ type: "stop" });
          } else if (e.key === "Backspace" && !text && chips.length) {
            setChips((prev) => prev.slice(0, -1));
          }
        }}
        onBlur={() => setTimeout(() => setQuery(undefined), 150)}
      />
      <div className="composer-bar">
        <select
          aria-label={t(locale, "composer.model")}
          value={state.currentModelId ?? ""}
          disabled={state.busy || state.phase !== "ready" || state.models.length === 0}
          onChange={(e) => send({ type: "selectModel", modelId: e.target.value })}
        >
          {state.models.length === 0 && <option value="">{t(locale, "composer.noModel")}</option>}
          {state.models.map((m) => (
            <option key={m.id} value={m.id} title={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        {state.usage && state.usage.size > 0 && (
          <span className="usage" title={t(locale, "usage", state.usage.used, state.usage.size)}>
            {formatTokens(state.usage.used)} / {formatTokens(state.usage.size)}
          </span>
        )}
        <span className="spacer" />
        {state.busy ? (
          <button type="button" className="stop" onClick={() => send({ type: "stop" })} title="Esc">
            ■ {t(locale, "composer.stop")}
          </button>
        ) : (
          <button type="button" className="send" disabled={!canSend} onClick={submit} title={t(locale, "composer.send")} aria-label={t(locale, "composer.send")}>
            ↑
          </button>
        )}
      </div>
    </div>
  );
}
