// Custom API page (F-04): shows the active endpoint and lets the user switch between the user's
// own Hermes config and an IDE-managed custom endpoint, test it, and save it.
import { useEffect, useState } from "react";
import type { ViewState } from "../../src/shared/protocol";
import { t, type Locale } from "../../src/shared/strings";
import { send } from "./host";

interface Props {
  state: ViewState;
  locale: Locale;
  open: boolean;
  onOpenChange(open: boolean): void;
}

export function EndpointCard({ state, locale, open, onOpenChange }: Props) {
  const ep = state.endpoint;
  const [mode, setMode] = useState(ep.mode);
  const [baseUrl, setBaseUrl] = useState(ep.baseUrl);
  const [model, setModel] = useState(ep.model);
  const [apiKey, setApiKey] = useState("");
  const [removeKey, setRemoveKey] = useState(false);
  const [contextLength, setContextLength] = useState(ep.contextLength);

  // Reset the form to the stored values whenever the editor is (re)opened.
  useEffect(() => {
    if (!open) return;
    setMode(ep.mode);
    setBaseUrl(ep.baseUrl);
    setModel(ep.model);
    setApiKey("");
    setRemoveKey(false);
    setContextLength(ep.contextLength);
  }, [open]);

  const test = state.test;
  const testLine = test.running ? (
    <div className="test-line running">{t(locale, "api.testing")}</div>
  ) : test.message ? (
    <div className={`test-line ${test.ok ? "ok" : "fail"}`}>
      <span aria-hidden>{test.ok ? "✓ " : "✕ "}</span>
      {test.message}
      {test.detail && <div className="test-detail">{test.detail}</div>}
    </div>
  ) : null;

  const hc = ep.hermesConfig;
  const notSet = t(locale, "api.notSet");

  if (!open) {
    const rows =
      ep.mode === "custom"
        ? [
            [t(locale, "api.baseUrl"), ep.baseUrl || notSet],
            [t(locale, "api.apiKey"), ep.keyHint || "—"],
            [t(locale, "api.model"), ep.model || notSet],
          ]
        : [
            [t(locale, "api.baseUrl"), hc?.baseUrl || hc?.provider || notSet],
            [t(locale, "api.model"), state.models.find((m) => m.id === state.currentModelId)?.label || hc?.model || notSet],
          ];
    return (
      <section className="card endpoint" aria-label={t(locale, "api.title")}>
        <div className="card-head">
          <span className="eyebrow">{ep.mode === "custom" ? t(locale, "api.mode.custom") : t(locale, "api.mode.hermes")}</span>
          <button type="button" className="secondary small" onClick={() => onOpenChange(true)}>
            {t(locale, "api.edit")}
          </button>
        </div>
        <dl className="kv">
          {rows.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd className="mono">{v}</dd>
            </div>
          ))}
        </dl>
        {testLine}
      </section>
    );
  }

  const testPayload = () =>
    mode === "custom"
      ? { baseUrl, model, apiKey: apiKey || undefined, contextLength: Number(contextLength) || 0 }
      : { baseUrl: "", model: "", contextLength: 0 };

  return (
    <section className="card endpoint editing" aria-label={t(locale, "api.title")}>
      <div className="card-head">
        <span className="eyebrow">{t(locale, "api.title")}</span>
        <button type="button" className="ghost small" onClick={() => onOpenChange(false)}>
          {t(locale, "api.close")}
        </button>
      </div>

      <div className="segmented" role="radiogroup" aria-label={t(locale, "api.title")}>
        {(["hermes", "custom"] as const).map((m) => (
          <button key={m} type="button" role="radio" aria-checked={mode === m} className={mode === m ? "on" : ""} onClick={() => setMode(m)}>
            {t(locale, m === "hermes" ? "api.mode.hermes" : "api.mode.custom")}
          </button>
        ))}
      </div>

      {mode === "hermes" ? (
        <>
          <p className="hint">{t(locale, "api.mode.hermesHint", hc?.path ?? "config.yaml")}</p>
          <dl className="kv">
            <div><dt>{t(locale, "api.provider")}</dt><dd className="mono">{hc?.provider || notSet}</dd></div>
            <div><dt>{t(locale, "api.baseUrl")}</dt><dd className="mono">{hc?.baseUrl || "—"}</dd></div>
            <div><dt>{t(locale, "api.model")}</dt><dd className="mono">{hc?.model || notSet}</dd></div>
          </dl>
        </>
      ) : (
        <>
          <p className="hint">{t(locale, "api.mode.customHint")}</p>
          <label className="field">
            <span>{t(locale, "api.baseUrl")}</span>
            <input className="mono" value={baseUrl} placeholder="https://llm.example.com/v1" spellCheck={false} onChange={(e) => setBaseUrl(e.target.value)} />
          </label>
          <label className="field">
            <span>
              {t(locale, "api.apiKey")}{" "}
              <em>{ep.hasKey && !removeKey ? t(locale, "api.apiKeyKeep", ep.keyHint) : t(locale, "api.apiKeyNone")}</em>
            </span>
            <input
              className="mono"
              type="password"
              value={apiKey}
              autoComplete="off"
              disabled={removeKey}
              placeholder={ep.hasKey && !removeKey ? ep.keyHint : "sk-…"}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </label>
          {ep.hasKey && (
            <label className="check">
              <input type="checkbox" checked={removeKey} onChange={(e) => setRemoveKey(e.target.checked)} />
              {t(locale, "api.removeKey")}
            </label>
          )}
          <label className="field">
            <span>{t(locale, "api.model")}</span>
            <input className="mono" value={model} placeholder="model-name" spellCheck={false} onChange={(e) => setModel(e.target.value)} />
          </label>
          <label className="field">
            <span>
              {t(locale, "api.context")} <em>{t(locale, "api.contextHint")}</em>
            </span>
            <input className="mono" type="number" min={0} step={1000} value={contextLength} onChange={(e) => setContextLength(Number(e.target.value))} />
          </label>
        </>
      )}

      {testLine}

      <div className="row-actions">
        <button type="button" className="secondary" disabled={test.running} onClick={() => send({ type: "testEndpoint", ...testPayload() })}>
          {test.running ? t(locale, "api.testing") : t(locale, "api.test")}
        </button>
        <button
          type="button"
          className="primary"
          onClick={() => {
            send({
              type: "saveEndpoint",
              mode,
              baseUrl,
              model,
              apiKey: removeKey ? "" : apiKey || undefined,
              contextLength: Number(contextLength) || 0,
            });
            onOpenChange(false);
          }}
        >
          {t(locale, "api.saveRestart")}
        </button>
      </div>
    </section>
  );
}
