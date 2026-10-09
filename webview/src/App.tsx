import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { HostToView, TranscriptItem, ViewState } from "../../src/shared/protocol";
import { t, type Locale, type StringKey } from "../../src/shared/strings";
import { EndpointCard } from "./EndpointCard";
import { formatTokens } from "./format";
import { send } from "./host";
import { Transcript } from "./Transcript";

export function App() {
  const [locale, setLocale] = useState<Locale>("en");
  const [state, setState] = useState<ViewState | undefined>();
  const [items, setItems] = useState<TranscriptItem[]>([]);
  const [endpointOpen, setEndpointOpen] = useState(false);
  const composer = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const onMessage = (event: MessageEvent<HostToView>) => {
      const msg = event.data;
      switch (msg.type) {
        case "init":
          setLocale(msg.locale);
          setState(msg.state);
          setItems(msg.items);
          break;
        case "state":
          setState(msg.state);
          break;
        case "items":
          setItems((prev) => upsert(prev, msg.items));
          break;
        case "reset":
          setItems(msg.items);
          break;
        case "focusComposer":
          composer.current?.focus();
          break;
        case "openEndpoint":
          setEndpointOpen(true);
          break;
      }
    };
    window.addEventListener("message", onMessage);
    send({ type: "ready" });
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Setup states need the endpoint form right away.
  useEffect(() => {
    if (state?.phase === "needsSetup" && state.endpoint.mode === "custom") setEndpointOpen(true);
  }, [state?.phase, state?.endpoint.mode]);

  if (!state) return <div className="loading">Hermes…</div>;

  return (
    <div className="app">
      <Header state={state} locale={locale} onSettings={() => setEndpointOpen((o) => !o)} />
      <Banner state={state} locale={locale} />
      <EndpointCard state={state} locale={locale} open={endpointOpen} onOpenChange={setEndpointOpen} />
      <Transcript items={items} locale={locale} cwd={state.cwd} busy={state.busy} />
      <Composer state={state} locale={locale} inputRef={composer} />
    </div>
  );
}

function upsert(prev: TranscriptItem[], incoming: TranscriptItem[]): TranscriptItem[] {
  const index = new Map(prev.map((it, i) => [it.id, i]));
  const next = prev.slice();
  for (const it of incoming) {
    const i = index.get(it.id);
    if (i === undefined) {
      index.set(it.id, next.length);
      next.push(it);
    } else {
      next[i] = it;
    }
  }
  return next;
}

function statusKey(state: ViewState): StringKey {
  if (state.phase === "ready" && state.busy) return "status.busy";
  return `status.${state.phase}` as StringKey;
}

function Header({ state, locale, onSettings }: { state: ViewState; locale: Locale; onSettings(): void }) {
  return (
    <header className="header">
      <span className="logo" aria-hidden>✦</span>
      <span className="title">{t(locale, "header.title")}</span>
      <span className={`status ${state.phase}${state.busy ? " busy" : ""}`}>
        <span className="dot" aria-hidden />
        {t(locale, statusKey(state))}
      </span>
      <span className="spacer" />
      <button type="button" className="icon" title={t(locale, "action.newSession")} aria-label={t(locale, "action.newSession")} onClick={() => send({ type: "newSession" })}>
        +
      </button>
      <button type="button" className="icon" title={t(locale, "action.settings")} aria-label={t(locale, "action.settings")} onClick={onSettings}>
        ⚙
      </button>
    </header>
  );
}

function Banner({ state, locale }: { state: ViewState; locale: Locale }) {
  const version = state.versionWarning ? <div className="banner warn">{state.versionWarning}</div> : null;
  const detail = state.phaseDetail ? <div className="banner-detail mono">{state.phaseDetail}</div> : null;
  switch (state.phase) {
    case "missing":
      return (
        <div className="banner warn">
          <p>{t(locale, "banner.missing")}</p>
          <p className="mono small">{t(locale, "banner.missingInstall")}</p>
          <button type="button" className="secondary" onClick={() => send({ type: "recheck" })}>{t(locale, "action.recheck")}</button>
        </div>
      );
    case "untrusted":
      return (
        <div className="banner warn">
          <p>{t(locale, "banner.untrusted")}</p>
          <button type="button" className="secondary" onClick={() => send({ type: "trustWorkspace" })}>{t(locale, "action.trust")}</button>
        </div>
      );
    case "noWorkspace":
      return <div className="banner info">{t(locale, "banner.noWorkspace")}</div>;
    case "needsSetup":
      return (
        <div className="banner warn">
          <p>{state.phaseDetail ?? t(locale, "banner.needsSetup")}</p>
          <button type="button" className="secondary" onClick={() => send({ type: "recheck" })}>{t(locale, "action.recheck")}</button>
        </div>
      );
    case "crashed":
      return (
        <div className="banner error">
          <p>{t(locale, "banner.crashed")}</p>
          {detail}
          <div className="row-actions">
            <button type="button" className="primary" onClick={() => send({ type: "restart" })}>{t(locale, "action.restart")}</button>
            <button type="button" className="ghost" onClick={() => send({ type: "showLog" })}>{t(locale, "action.showLog")}</button>
          </div>
        </div>
      );
    default:
      return version;
  }
}

function Composer({ state, locale, inputRef }: { state: ViewState; locale: Locale; inputRef: RefObject<HTMLTextAreaElement> }) {
  const [text, setText] = useState("");
  const canSend = !state.busy && ["ready", "stopped", "crashed"].includes(state.phase) && text.trim().length > 0;

  const submit = useCallback(() => {
    if (!canSend) return;
    send({ type: "send", text });
    setText("");
  }, [canSend, text]);

  // Auto-grow up to a limit.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text, inputRef]);

  return (
    <div className="composer">
      <textarea
        ref={inputRef}
        value={text}
        rows={2}
        placeholder={t(locale, "composer.placeholder")}
        aria-label={t(locale, "composer.placeholder")}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          } else if (e.key === "Escape" && state.busy) {
            e.preventDefault();
            send({ type: "stop" });
          }
        }}
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
