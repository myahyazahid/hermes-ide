// Custom API page (F-04) with endpoint profiles (F-16), the terminal-approval status (story 4)
// and MCP servers (F-15).
import { useEffect, useState } from "react";
import { SUPPORTED_HERMES } from "../../src/shared/hermesVersions";
import { ENDPOINT_PRESETS, PRESET_GROUPS, type EndpointPreset } from "../../src/shared/presets";
import type { HostToView, McpServerView, ProfileView, RoutingView, ViewState } from "../../src/shared/protocol";
import { t, type Locale, type StringKey } from "../../src/shared/strings";
import { CompletionSection, IndexSection, indexStatusText } from "./FeaturesSection";
import { send } from "./host";

/** Values a preset from the quick-start card pre-fills into the new-profile form. `key` changes per click to reset the form. */
export interface PresetDraft {
  key: number;
  name: string;
  baseUrl: string;
  modelHint: string;
  presetId?: string;
}

interface Props {
  state: ViewState;
  locale: Locale;
  open: boolean;
  onOpenChange(open: boolean): void;
  draft?: PresetDraft;
}

const NEW = "__new__";

export function SettingsCard({ state, locale, open, onOpenChange, draft }: Props) {
  const { profiles, activeProfileId, hermesConfig } = state.endpoint;
  const active = profiles.find((p) => p.id === activeProfileId) ?? profiles[0];
  const [selected, setSelected] = useState(activeProfileId);

  useEffect(() => {
    if (open) setSelected(draft ? NEW : activeProfileId);
  }, [open, activeProfileId, draft]);

  const notSet = t(locale, "api.notSet");
  const testLine = <TestLine state={state} locale={locale} />;
  const approval = <ApprovalLine state={state} locale={locale} />;

  if (!open) {
    const rows: [string, string][] =
      active?.kind === "custom"
        ? [
            [t(locale, "api.baseUrl"), active.baseUrl || notSet],
            [t(locale, "api.apiKey"), active.keyHint || "—"],
            [t(locale, "api.model"), state.models.find((m) => m.id === state.currentModelId)?.label || active.model || notSet],
          ]
        : [
            [t(locale, "api.baseUrl"), hermesConfig?.baseUrl || hermesConfig?.provider || notSet],
            [t(locale, "api.model"), state.models.find((m) => m.id === state.currentModelId)?.label || hermesConfig?.model || notSet],
          ];
    const mcpOn = state.mcpServers.filter((s) => s.enabled).length;
    return (
      <section className="card endpoint" aria-label={t(locale, "api.title")}>
        <div className="card-head">
          <span className="eyebrow">{active?.name ?? t(locale, "api.title")}</span>
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
          {state.completion.enabled && (
            <div>
              <dt>Tab</dt>
              <dd className="mono">{state.completion.model}{state.completion.avgLatencyMs !== undefined ? ` · ${state.completion.avgLatencyMs} ms` : ""}</dd>
            </div>
          )}
          {state.index.enabled && (
            <div>
              <dt>Index</dt>
              <dd className="mono">{indexStatusText(state.index, locale)}</dd>
            </div>
          )}
          {mcpOn > 0 && (
            <div>
              <dt>MCP</dt>
              <dd className="mono">{state.mcpServers.filter((s) => s.enabled).map((s) => s.name).join(", ")}</dd>
            </div>
          )}
        </dl>
        {testLine}
        {approval}
      </section>
    );
  }

  const editing = selected === NEW ? undefined : profiles.find((p) => p.id === selected);

  return (
    <section className="card endpoint editing" aria-label={t(locale, "api.title")}>
      <div className="card-head">
        <span className="eyebrow">{t(locale, "api.title")}</span>
        <button type="button" className="ghost small" onClick={() => onOpenChange(false)}>
          {t(locale, "api.close")}
        </button>
      </div>

      <div className="profile-list" role="radiogroup" aria-label={t(locale, "profiles.pick")}>
        {profiles.map((p) => (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={selected === p.id}
            className={`profile ${selected === p.id ? "on" : ""}`}
            onClick={() => setSelected(p.id)}
          >
            <span className="profile-name">{p.name}</span>
            <span className="badge" aria-hidden>{p.id === activeProfileId ? "●" : ""}</span>
            <span className="profile-model mono">{p.kind === "hermes" ? hermesConfig?.model ?? "" : p.model}</span>
          </button>
        ))}
        <button type="button" role="radio" aria-checked={selected === NEW} className={`profile add ${selected === NEW ? "on" : ""}`} onClick={() => setSelected(NEW)}>
          + {t(locale, "profiles.new")}
        </button>
      </div>

      {editing?.kind === "hermes" ? (
        <HermesProfile state={state} locale={locale} isActive={editing.id === activeProfileId} />
      ) : (
        <CustomProfileForm
          key={selected === NEW ? `new-${draft?.key ?? 0}` : selected}
          profile={editing}
          draft={selected === NEW ? draft : undefined}
          locale={locale}
          state={state}
          onSaved={() => onOpenChange(false)}
        />
      )}

      {testLine}
      {approval}
      <LanguageSection state={state} locale={locale} />
      <LearningSection state={state} locale={locale} />
      <PrivacySection state={state} locale={locale} />
      <RoutingSection state={state} locale={locale} />
      <HermesSection state={state} locale={locale} />
      <McpSection state={state} locale={locale} />
      <CompletionSection state={state} locale={locale} />
      <IndexSection state={state} locale={locale} />
    </section>
  );
}

function TestLine({ state, locale }: { state: ViewState; locale: Locale }) {
  const test = state.test;
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

function ApprovalLine({ state, locale }: { state: ViewState; locale: Locale }) {
  switch (state.terminalApproval) {
    case "active":
      return <div className="approval-line ok">✓ {t(locale, state.asksEveryCommand === false ? "approval.guardOnly" : "approval.active")}</div>;
    case "unavailable":
      return <div className="approval-line warn">{t(locale, "approval.unavailable")}</div>;
    case "needsConsent":
    case "dismissed":
      return (
        <div className="approval-line warn">
          {t(locale, "approval.riskyOnly")}{" "}
          <button type="button" className="link-btn" onClick={() => send({ type: "enableTerminalApproval" })}>
            {t(locale, "approval.enable")}
          </button>
        </div>
      );
    default:
      return null;
  }
}

function HermesProfile({ state, locale, isActive }: { state: ViewState; locale: Locale; isActive: boolean }) {
  const hc = state.endpoint.hermesConfig;
  const notSet = t(locale, "api.notSet");
  return (
    <>
      <p className="hint">{t(locale, "api.mode.hermesHint", hc?.path ?? "config.yaml")}</p>
      <dl className="kv">
        <div><dt>{t(locale, "api.provider")}</dt><dd className="mono">{hc?.provider || notSet}</dd></div>
        <div><dt>{t(locale, "api.baseUrl")}</dt><dd className="mono">{hc?.baseUrl || "—"}</dd></div>
        <div><dt>{t(locale, "api.model")}</dt><dd className="mono">{hc?.model || notSet}</dd></div>
      </dl>
      <div className="row-actions">
        <button type="button" className="secondary" disabled={state.test.running} onClick={() => send({ type: "testEndpoint", baseUrl: "", model: "", contextLength: 0 })}>
          {state.test.running ? t(locale, "api.testing") : t(locale, "api.test")}
        </button>
        {!isActive && (
          <button type="button" className="primary" onClick={() => send({ type: "selectProfile", id: "hermes" })}>
            {t(locale, "profiles.use")}
          </button>
        )}
      </div>
    </>
  );
}

function CustomProfileForm({ profile, draft, locale, state, onSaved }: { profile?: ProfileView; draft?: PresetDraft; locale: Locale; state: ViewState; onSaved(): void }) {
  const [name, setName] = useState(profile?.name ?? draft?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(profile?.baseUrl ?? draft?.baseUrl ?? "");
  const [model, setModel] = useState(profile?.model ?? "");
  const [apiKey, setApiKey] = useState("");
  const [removeKey, setRemoveKey] = useState(false);
  const [contextLength, setContextLength] = useState(profile?.contextLength ?? 0);
  const [presetId, setPresetId] = useState(draft?.presetId ?? "");
  const [models, setModels] = useState<{ list: string[]; message?: string; loading?: boolean }>({ list: [] });
  const isActive = profile?.id === state.endpoint.activeProfileId;
  const preset: EndpointPreset | undefined = ENDPOINT_PRESETS.find((p) => p.id === presetId);

  // The host answers a model-list request for the address the form had when it asked.
  useEffect(() => {
    const onMessage = (event: MessageEvent<HostToView>) => {
      const msg = event.data;
      if (msg.type === "endpointModels" && msg.baseUrl === baseUrl) {
        setModels({ list: msg.models, message: msg.error ?? t(locale, "presets.modelsLoaded", msg.models.length) });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [baseUrl, locale]);

  const choosePreset = (id: string) => {
    setPresetId(id);
    const p = ENDPOINT_PRESETS.find((x) => x.id === id);
    if (!p) return;
    setName(p.label);
    setBaseUrl(p.baseUrl);
    setModels({ list: [] });
  };

  return (
    <>
      <p className="hint">{t(locale, "api.mode.customHint")}</p>
      {!profile && (
        <label className="field">
          <span>{t(locale, "presets.start")}</span>
          <select value={presetId} onChange={(e) => choosePreset(e.target.value)}>
            <option value="">{t(locale, "presets.none")}</option>
            {PRESET_GROUPS.map((group) => (
              <optgroup key={group} label={t(locale, `presets.group.${group}`)}>
                {ENDPOINT_PRESETS.filter((p) => p.group === group).map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </optgroup>
            ))}
          </select>
        </label>
      )}
      {preset && (
        <div className="preset-info">
          <p className="hint">{preset.note[locale]}</p>
          {preset.remote && <p className={`hint${state.privacy?.localOnly ? " warn-text" : ""}`}>{t(locale, state.privacy?.localOnly ? "presets.remoteLocal" : "presets.remote")}</p>}
          {preset.pricingUrl && <p className="hint">{t(locale, "presets.priceNote")}</p>}
          <div className="row-actions">
            {preset.helpUrl && <button type="button" className="link-btn" onClick={() => send({ type: "openUrl", url: preset.helpUrl! })}>{t(locale, "presets.help")}</button>}
            {preset.pricingUrl && <button type="button" className="link-btn" onClick={() => send({ type: "openUrl", url: preset.pricingUrl! })}>{t(locale, "presets.pricing")}</button>}
          </div>
        </div>
      )}
      <label className="field">
        <span>{t(locale, "profiles.name")}</span>
        <input value={name} placeholder="VPS vLLM" onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        <span>{t(locale, "api.baseUrl")}</span>
        <input className="mono" value={baseUrl} placeholder="https://llm.example.com/v1" spellCheck={false} onChange={(e) => setBaseUrl(e.target.value)} />
      </label>
      <label className="field">
        <span>
          {t(locale, "api.apiKey")} <em>{profile?.hasKey && !removeKey ? t(locale, "api.apiKeyKeep", profile.keyHint) : t(locale, "api.apiKeyNone")}</em>
        </span>
        <input
          className="mono"
          type="password"
          value={apiKey}
          autoComplete="off"
          disabled={removeKey}
          placeholder={profile?.hasKey && !removeKey ? profile.keyHint : "sk-…"}
          onChange={(e) => setApiKey(e.target.value)}
        />
      </label>
      {profile?.hasKey && (
        <label className="check">
          <input type="checkbox" checked={removeKey} onChange={(e) => setRemoveKey(e.target.checked)} />
          {t(locale, "api.removeKey")}
        </label>
      )}
      <label className="field">
        <span>{t(locale, "api.model")}</span>
        <input className="mono" value={model} list="endpoint-models" placeholder={preset?.modelHint || draft?.modelHint || t(locale, "presets.modelPlaceholder")} spellCheck={false} onChange={(e) => setModel(e.target.value)} />
        <datalist id="endpoint-models">{models.list.map((m) => <option key={m} value={m} />)}</datalist>
      </label>
      <div className="row-actions">
        <button
          type="button"
          className="secondary small"
          disabled={!baseUrl.trim() || models.loading}
          onClick={() => {
            setModels({ list: [], loading: true, message: t(locale, "presets.fetching") });
            send({ type: "listModels", baseUrl, apiKey: apiKey || undefined, profileId: profile?.id });
          }}
        >
          {t(locale, "presets.listModels")}
        </button>
        {models.message && <span className="hint">{models.message}</span>}
      </div>
      <label className="field">
        <span>
          {t(locale, "api.context")} <em>{t(locale, "api.contextHint")}</em>
        </span>
        <input className="mono" type="number" min={0} step={1000} value={contextLength} onChange={(e) => setContextLength(Number(e.target.value))} />
      </label>
      <div className="row-actions">
        <button
          type="button"
          className="secondary"
          disabled={state.test.running}
          onClick={() => send({ type: "testEndpoint", profileId: profile?.id, baseUrl, model, apiKey: apiKey || undefined, contextLength: Number(contextLength) || 0 })}
        >
          {state.test.running ? t(locale, "api.testing") : t(locale, "api.test")}
        </button>
        <button
          type="button"
          className="primary"
          onClick={() => {
            send({
              type: "saveProfile",
              profile: { id: profile?.id, name: name || "Custom API", baseUrl, model, contextLength: Number(contextLength) || 0 },
              apiKey: removeKey ? "" : apiKey || undefined,
            });
            onSaved();
          }}
        >
          {isActive ? t(locale, "api.saveRestart") : t(locale, "profiles.saveUse")}
        </button>
        {profile && (
          <button type="button" className="ghost" onClick={() => send({ type: "deleteProfile", id: profile.id })}>
            {t(locale, "profiles.delete")}
          </button>
        )}
      </div>
    </>
  );
}

/** Panel language and the language the agent answers in (phase 7): Indonesian by default, each can be changed apart. */
function LanguageSection({ state, locale }: { state: ViewState; locale: Locale }) {
  const lang = state.language;
  if (!lang) return null;
  return (
    <details className="language">
      <summary>{t(locale, "lang.title")}</summary>
      <p className="hint">{t(locale, "lang.hint")}</p>
      <label className="field">
        <span>{t(locale, "lang.ui")}</span>
        <select value={lang.ui} onChange={(e) => send({ type: "setLanguage", ui: e.target.value as typeof lang.ui })}>
          <option value="id">{t(locale, "lang.id")}</option>
          <option value="en">{t(locale, "lang.en")}</option>
          <option value="auto">{t(locale, "lang.auto")}</option>
        </select>
      </label>
      <label className="field">
        <span>{t(locale, "lang.agent")}</span>
        <select value={lang.agent} onChange={(e) => send({ type: "setLanguage", agent: e.target.value as typeof lang.agent })}>
          <option value="ui">{t(locale, "lang.agentUi")}</option>
          <option value="id">{t(locale, "lang.id")}</option>
          <option value="en">{t(locale, "lang.en")}</option>
          <option value="off">{t(locale, "lang.agentOff")}</option>
        </select>
      </label>
    </details>
  );
}

/** Learning mode (phase 7): on or off for this workspace, and how deep the explanations go. */
function LearningSection({ state, locale }: { state: ViewState; locale: Locale }) {
  const learning = state.learning;
  if (!learning) return null;
  return (
    <details className="learning" open={learning.on || undefined}>
      <summary>
        {t(locale, "learning.title")} <span className="muted">{learning.on ? "· 🎓" : ""}</span>
      </summary>
      <p className="hint">{t(locale, "learning.hint")}</p>
      <label className="check">
        <input type="checkbox" checked={learning.on} onChange={(e) => send({ type: "setLearning", on: e.target.checked })} />
        {t(locale, "learning.enable")}
      </label>
      <label className="field">
        <span>{t(locale, "learning.level")}</span>
        <select value={learning.level} onChange={(e) => send({ type: "setLearning", level: e.target.value as typeof learning.level })}>
          <option value="beginner">{t(locale, "learning.beginner")}</option>
          <option value="intermediate">{t(locale, "learning.intermediate")}</option>
        </select>
      </label>
    </details>
  );
}

/** Full local mode (phase 6): the switch, the list of the user's own servers, and the privacy check. */
function PrivacySection({ state, locale }: { state: ViewState; locale: Locale }) {
  const p = state.privacy;
  const [hosts, setHosts] = useState((p?.allowedHosts ?? []).join("\n"));
  useEffect(() => setHosts((p?.allowedHosts ?? []).join("\n")), [p?.allowedHosts]);
  const dirty = hosts.split(/\s+/).filter(Boolean).join("\n") !== (p?.allowedHosts ?? []).join("\n");
  return (
    <details className="privacy" open={p?.localOnly || undefined}>
      <summary>
        {t(locale, "privacy.settings.title")} <span className="muted">{p?.localOnly ? "· 🔒" : ""}</span>
      </summary>
      <p className="hint">{t(locale, "privacy.settings.hint")}</p>
      <label className="check">
        <input type="checkbox" checked={!!p?.localOnly} onChange={(e) => send({ type: "setLocalOnly", enabled: e.target.checked })} />
        {t(locale, "privacy.settings.enable")}
      </label>
      <label className="field">
        <span>{t(locale, "privacy.settings.hosts")}</span>
        <textarea className="mono" rows={3} value={hosts} spellCheck={false} placeholder="vps.example.com" onChange={(e) => setHosts(e.target.value)} />
      </label>
      <div className="row-actions">
        <button type="button" className="secondary small" disabled={!dirty} onClick={() => send({ type: "saveAllowedHosts", hosts: hosts.split(/\s+/).filter(Boolean) })}>
          {t(locale, "privacy.settings.save")}
        </button>
        <button type="button" className="secondary small" onClick={() => send({ type: "showPrivacy" })}>
          {t(locale, "privacy.report")}
        </button>
      </div>
    </details>
  );
}

/** Automatic model routing (phase 6): which model answers light questions, which one heavy work, and who is the fallback. */
function RoutingSection({ state, locale }: { state: ViewState; locale: Locale }) {
  const saved = state.routing;
  const [draft, setDraft] = useState<RoutingView | undefined>(saved);
  useEffect(() => setDraft(saved), [saved]);
  if (!saved || !draft) return null;
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const choose = (field: "lightModel" | "heavyModel" | "fallbackModel", label: StringKey) => {
    const known = state.models.some((m) => m.id === draft[field]);
    return (
      <label className="field">
        <span>{t(locale, label)}</span>
        <select value={draft[field]} onChange={(e) => setDraft({ ...draft, [field]: e.target.value })}>
          <option value="">{t(locale, "routing.none")}</option>
          {draft[field] && !known && <option value={draft[field]}>{draft[field]}</option>}
          {state.models.filter((m) => !m.blocked).map((m) => (
            <option key={m.id} value={m.id}>{m.group ? `${m.group} · ${m.label}` : m.label}</option>
          ))}
        </select>
      </label>
    );
  };
  return (
    <details className="routing" open={saved.enabled || undefined}>
      <summary>
        {t(locale, "routing.title")} <span className="muted">{saved.enabled ? "· ⇄" : ""}</span>
      </summary>
      <p className="hint">{t(locale, "routing.hint")}</p>
      <label className="check">
        <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
        {t(locale, "routing.enable")}
      </label>
      {state.models.length === 0 && <p className="hint">{t(locale, "routing.needModels")}</p>}
      {choose("lightModel", "routing.light")}
      {choose("heavyModel", "routing.heavy")}
      {choose("fallbackModel", "routing.fallback")}
      <label className="field">
        <span>{t(locale, "routing.maxChars")}</span>
        <input type="number" min={20} max={4000} value={draft.lightMaxChars} onChange={(e) => setDraft({ ...draft, lightMaxChars: Number(e.target.value) || saved.lightMaxChars })} />
      </label>
      <div className="row-actions">
        <button type="button" className="secondary small" disabled={!dirty} onClick={() => send({ type: "saveRouting", routing: draft })}>
          {t(locale, "routing.save")}
        </button>
      </div>
    </details>
  );
}

/** Installed Hermes version against the tested range, with the guarded update flow. */
function HermesSection({ state, locale }: { state: ViewState; locale: Locale }) {
  const range = `>=${SUPPORTED_HERMES.min} <${SUPPORTED_HERMES.maxExclusive}`;
  const version = state.hermesVersion;
  const working = state.hermesUpdate === "checking" || state.hermesUpdate === "updating";
  return (
    <details className="hermes-maint">
      <summary>{t(locale, "hermesMaint.section")}</summary>
      {version && state.hermesStatus && (
        <p className={`hint ${state.hermesStatus === "tested" ? "" : "warn-text"}`}>{t(locale, `hermesMaint.status.${state.hermesStatus}` as StringKey, version, range)}</p>
      )}
      {state.hermesUpdate && <p className="hint">{t(locale, `hermesMaint.state.${state.hermesUpdate}` as StringKey)}</p>}
      <div className="row-actions">
        <button type="button" className="secondary small" disabled={working || state.busy || !version} onClick={() => send({ type: "checkHermesUpdate" })}>
          {t(locale, "hermesMaint.checkBtn")}
        </button>
        {state.hermesUpdate === "available" && (
          <button type="button" className="primary small" disabled={working || state.busy} onClick={() => send({ type: "updateHermes" })}>
            {t(locale, "hermesMaint.updateBtn")}
          </button>
        )}
      </div>
    </details>
  );
}

function McpSection({ state, locale }: { state: ViewState; locale: Locale }) {
  const [servers, setServers] = useState<McpServerView[]>(state.mcpServers);
  const [draft, setDraft] = useState<{ name: string; type: McpServerView["type"]; command: string; args: string; url: string }>({
    name: "", type: "stdio", command: "", args: "", url: "",
  });

  useEffect(() => setServers(state.mcpServers), [state.mcpServers]);
  const dirty = JSON.stringify(servers) !== JSON.stringify(state.mcpServers);

  const addDraft = () => {
    if (!draft.name.trim()) return;
    const args = [...draft.args.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
    setServers((prev) => [
      ...prev,
      draft.type === "stdio"
        ? { name: draft.name.trim(), type: "stdio", command: draft.command.trim(), args, enabled: true }
        : { name: draft.name.trim(), type: draft.type, url: draft.url.trim(), enabled: true },
    ]);
    setDraft({ name: "", type: draft.type, command: "", args: "", url: "" });
  };

  return (
    <details className="mcp" open={servers.length > 0 || undefined}>
      <summary>
        {t(locale, "mcp.title")} <span className="muted">({servers.filter((s) => s.enabled).length})</span>
      </summary>
      <p className="hint">{t(locale, "mcp.hint")}</p>
      {servers.length === 0 && <p className="hint">{t(locale, "mcp.empty")}</p>}
      <ul className="mcp-list">
        {servers.map((s, i) => (
          <li key={s.name}>
            <label className="check">
              <input
                type="checkbox"
                checked={s.enabled}
                onChange={(e) => setServers((prev) => prev.map((x, j) => (j === i ? { ...x, enabled: e.target.checked } : x)))}
              />
              <span className="mono">{s.name}</span>
            </label>
            <span className="mono muted mcp-target">{s.type === "stdio" ? [s.command, ...(s.args ?? [])].join(" ") : s.url}</span>
            <button type="button" className="ghost small" onClick={() => setServers((prev) => prev.filter((_, j) => j !== i))}>
              {t(locale, "mcp.remove")}
            </button>
          </li>
        ))}
      </ul>
      <div className="mcp-add">
        <input aria-label={t(locale, "mcp.name")} placeholder={t(locale, "mcp.name")} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        <select aria-label={t(locale, "mcp.type")} value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value as McpServerView["type"] })}>
          <option value="stdio">stdio</option>
          <option value="http">http</option>
          <option value="sse">sse</option>
        </select>
        {draft.type === "stdio" ? (
          <>
            <input className="mono" aria-label={t(locale, "mcp.command")} placeholder="npx" value={draft.command} onChange={(e) => setDraft({ ...draft, command: e.target.value })} />
            <input className="mono wide" aria-label={t(locale, "mcp.args")} placeholder="-y @modelcontextprotocol/server-filesystem ." value={draft.args} onChange={(e) => setDraft({ ...draft, args: e.target.value })} />
          </>
        ) : (
          <input className="mono wide" aria-label={t(locale, "mcp.url")} placeholder="https://mcp.example.com/mcp" value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} />
        )}
        <button type="button" className="secondary small" onClick={addDraft} disabled={!draft.name.trim()}>
          + {t(locale, "mcp.add")}
        </button>
      </div>
      {state.mcpError && <div className="test-line fail">{state.mcpError}</div>}
      {dirty && (
        <div className="row-actions">
          <button type="button" className="primary" onClick={() => send({ type: "saveMcpServers", servers })}>
            {t(locale, "mcp.save")}
          </button>
        </div>
      )}
    </details>
  );
}
