import { useEffect, useRef, useState } from "react";
import type { ContextRef, HostToView, MentionItem, TranscriptItem, ViewState } from "../../src/shared/protocol";
import { t, type Locale, type StringKey } from "../../src/shared/strings";
import { Composer } from "./Composer";
import { send } from "./host";
import { SettingsCard } from "./SettingsCard";
import { Transcript } from "./Transcript";

export function App() {
  const [locale, setLocale] = useState<Locale>("en");
  const [state, setState] = useState<ViewState | undefined>();
  const [items, setItems] = useState<TranscriptItem[]>([]);
  const [endpointOpen, setEndpointOpen] = useState(false);
  const [chips, setChips] = useState<ContextRef[]>([]);
  const [mention, setMention] = useState<{ requestId: number; items: MentionItem[] }>();
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
        case "addContext":
          setChips((prev) =>
            prev.some((c) => c.kind === msg.ref.kind && c.path === msg.ref.path && c.startLine === msg.ref.startLine) ? prev : [...prev, msg.ref],
          );
          composer.current?.focus();
          break;
        case "mentionResults":
          setMention({ requestId: msg.requestId, items: msg.items });
          break;
      }
    };
    window.addEventListener("message", onMessage);
    send({ type: "ready" });
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Setup states need the endpoint form right away.
  useEffect(() => {
    if (state?.phase === "needsSetup" && state.endpoint.activeProfileId !== "hermes") setEndpointOpen(true);
  }, [state?.phase, state?.endpoint.activeProfileId]);

  if (!state) return <div className="loading">Hermes…</div>;

  return (
    <div className="app">
      <Header state={state} locale={locale} onSettings={() => setEndpointOpen((o) => !o)} />
      <Banner state={state} locale={locale} />
      <ApprovalBanner state={state} locale={locale} />
      <SettingsCard state={state} locale={locale} open={endpointOpen} onOpenChange={setEndpointOpen} />
      <Transcript items={items} locale={locale} cwd={state.cwd} busy={state.busy} />
      <Composer state={state} locale={locale} inputRef={composer} chips={chips} setChips={setChips} mention={mention} />
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

/** User story 4: one-time consent to add the approval hook to the user's own Hermes config. */
function ApprovalBanner({ state, locale }: { state: ViewState; locale: Locale }) {
  if (state.terminalApproval !== "needsConsent" || state.phase !== "ready") return null;
  return (
    <div className="banner warn" role="region" aria-label={t(locale, "approval.title")}>
      <p className="banner-title">{t(locale, "approval.title")}</p>
      <p>{t(locale, "approval.body", state.endpoint.hermesConfig?.path ?? "config.yaml")}</p>
      <div className="row-actions">
        <button type="button" className="primary" onClick={() => send({ type: "enableTerminalApproval" })}>{t(locale, "approval.enable")}</button>
        <button type="button" className="ghost" onClick={() => send({ type: "dismissTerminalApproval" })}>{t(locale, "approval.later")}</button>
      </div>
    </div>
  );
}
