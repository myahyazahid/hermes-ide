// Settings for the features that run outside Hermes: Tab autocomplete (F-17) and the codebase
// index (F-18). Each has its own endpoint and key.
import { useEffect, useState } from "react";
import type { IndexView, TestView, ViewState } from "../../src/shared/protocol";
import { t, type Locale } from "../../src/shared/strings";
import { send } from "./host";

export function indexStatusText(index: IndexView, locale: Locale): string {
  switch (index.status) {
    case "indexing":
      return t(locale, "index.status.indexing", index.done ?? 0, index.total ?? 0);
    case "ready":
      return t(locale, "index.status.ready", index.files, index.chunks);
    case "error":
      return t(locale, "index.status.error", index.error ?? "");
    default:
      return t(locale, `index.status.${index.status}`);
  }
}

function TestResult({ test, locale }: { test?: TestView; locale: Locale }) {
  if (!test) return null;
  if (test.running) return <div className="test-line running">{t(locale, "api.testing")}</div>;
  if (!test.message) return null;
  return (
    <div className={`test-line ${test.ok ? "ok" : "fail"}`}>
      <span aria-hidden>{test.ok ? "✓ " : "✕ "}</span>
      {test.message}
      {test.detail && <div className="test-detail">{test.detail}</div>}
    </div>
  );
}

function KeyField({ hasKey, keyHint, value, onChange, remove, onRemove, locale }: {
  hasKey: boolean; keyHint: string; value: string; onChange(v: string): void; remove: boolean; onRemove(v: boolean): void; locale: Locale;
}) {
  return (
    <>
      <label className="field">
        <span>
          {t(locale, "api.apiKey")} <em>{hasKey && !remove ? t(locale, "api.apiKeyKeep", keyHint) : t(locale, "api.apiKeyNone")}</em>
        </span>
        <input className="mono" type="password" value={value} autoComplete="off" disabled={remove}
          placeholder={hasKey && !remove ? keyHint : "sk-…"} onChange={(e) => onChange(e.target.value)} />
      </label>
      {hasKey && (
        <label className="check">
          <input type="checkbox" checked={remove} onChange={(e) => onRemove(e.target.checked)} />
          {t(locale, "api.removeKey")}
        </label>
      )}
    </>
  );
}

export function CompletionSection({ state, locale }: { state: ViewState; locale: Locale }) {
  const c = state.completion;
  const [enabled, setEnabled] = useState(c.enabled);
  const [baseUrl, setBaseUrl] = useState(c.baseUrl);
  const [model, setModel] = useState(c.model);
  const [template, setTemplate] = useState(c.template);
  const [apiKey, setApiKey] = useState("");
  const [removeKey, setRemoveKey] = useState(false);
  useEffect(() => {
    setEnabled(c.enabled);
    setBaseUrl(c.baseUrl);
    setModel(c.model);
    setTemplate(c.template);
  }, [c.enabled, c.baseUrl, c.model, c.template]);

  return (
    <details className="feature" open={c.enabled || undefined}>
      <summary>
        {t(locale, "completion.title")}{" "}
        <span className="muted">
          {c.enabled ? `· ${c.model}${c.avgLatencyMs !== undefined ? ` · ${t(locale, "completion.avg", c.avgLatencyMs)}` : ""}` : `· ${t(locale, "index.status.disabled")}`}
        </span>
      </summary>
      <p className="hint">{t(locale, "completion.hint")}</p>
      <label className="check">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        {t(locale, "completion.enabled")}
      </label>
      <label className="field">
        <span>{t(locale, "api.baseUrl")}</span>
        <input className="mono" value={baseUrl} placeholder="http://localhost:11434/v1" spellCheck={false} onChange={(e) => setBaseUrl(e.target.value)} />
      </label>
      <KeyField hasKey={c.hasKey} keyHint={c.keyHint} value={apiKey} onChange={setApiKey} remove={removeKey} onRemove={setRemoveKey} locale={locale} />
      <label className="field">
        <span>{t(locale, "api.model")}</span>
        <input className="mono" value={model} placeholder="qwen2.5-coder:1.5b" spellCheck={false} onChange={(e) => setModel(e.target.value)} />
      </label>
      <label className="field">
        <span>{t(locale, "completion.template")}</span>
        <select value={template} onChange={(e) => setTemplate(e.target.value)}>
          <option value="auto">{t(locale, "completion.templateAuto")}</option>
          <option value="suffix">{t(locale, "completion.templateSuffix")}</option>
          <option value="qwen">Qwen2.5-Coder</option>
          <option value="starcoder">StarCoder</option>
          <option value="codellama">CodeLlama</option>
          <option value="deepseek">DeepSeek-Coder</option>
        </select>
      </label>
      {c.lastError && <div className="test-line fail">{c.lastError}</div>}
      <TestResult test={state.completionTest} locale={locale} />
      <div className="row-actions">
        <button type="button" className="secondary" disabled={state.completionTest?.running}
          onClick={() => send({ type: "testCompletion", baseUrl, model, template, apiKey: apiKey || undefined })}>
          {t(locale, "api.test")}
        </button>
        <button type="button" className="primary"
          onClick={() => send({ type: "saveCompletion", enabled, baseUrl, model, template, apiKey: removeKey ? "" : apiKey || undefined })}>
          {t(locale, "completion.save")}
        </button>
      </div>
    </details>
  );
}

export function IndexSection({ state, locale }: { state: ViewState; locale: Locale }) {
  const ix = state.index;
  const [enabled, setEnabled] = useState(ix.enabled);
  const [baseUrl, setBaseUrl] = useState(ix.baseUrl);
  const [model, setModel] = useState(ix.model);
  const [apiKey, setApiKey] = useState("");
  const [removeKey, setRemoveKey] = useState(false);
  useEffect(() => {
    setEnabled(ix.enabled);
    setBaseUrl(ix.baseUrl);
    setModel(ix.model);
  }, [ix.enabled, ix.baseUrl, ix.model]);

  const pct = ix.status === "indexing" && ix.total ? Math.round(((ix.done ?? 0) / ix.total) * 100) : undefined;
  return (
    <details className="feature" open={ix.enabled || undefined}>
      <summary>
        {t(locale, "index.title")} <span className="muted">· {indexStatusText(ix, locale)}</span>
      </summary>
      <p className="hint">{t(locale, "index.hint")}</p>
      {pct !== undefined && (
        <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div style={{ width: `${pct}%` }} />
        </div>
      )}
      <label className="check">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        {t(locale, "index.enabled")}
      </label>
      <label className="field">
        <span>{t(locale, "api.baseUrl")}</span>
        <input className="mono" value={baseUrl} placeholder="http://localhost:11434/v1" spellCheck={false} onChange={(e) => setBaseUrl(e.target.value)} />
      </label>
      <KeyField hasKey={ix.hasKey} keyHint={ix.keyHint} value={apiKey} onChange={setApiKey} remove={removeKey} onRemove={setRemoveKey} locale={locale} />
      <label className="field">
        <span>{t(locale, "api.model")}</span>
        <input className="mono" value={model} placeholder="nomic-embed-text" spellCheck={false} onChange={(e) => setModel(e.target.value)} />
      </label>
      <TestResult test={state.indexTest} locale={locale} />
      <div className="row-actions">
        <button type="button" className="secondary" disabled={state.indexTest?.running}
          onClick={() => send({ type: "testIndex", baseUrl, model, apiKey: apiKey || undefined })}>
          {t(locale, "api.test")}
        </button>
        <button type="button" className="primary"
          onClick={() => send({ type: "saveIndex", enabled, baseUrl, model, apiKey: removeKey ? "" : apiKey || undefined })}>
          {t(locale, "completion.save")}
        </button>
        {ix.enabled && ix.status !== "indexing" && (
          <button type="button" className="ghost" onClick={() => send({ type: "rebuildIndex" })}>
            {t(locale, "index.rebuild")}
          </button>
        )}
      </div>
    </details>
  );
}
