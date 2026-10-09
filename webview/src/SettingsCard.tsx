// Custom API page (F-04) with endpoint profiles (F-16), the terminal-approval status (story 4)
// and MCP servers (F-15).
import { useEffect, useState } from "react";
import type { McpServerView, ProfileView, ViewState } from "../../src/shared/protocol";
import { t, type Locale } from "../../src/shared/strings";
import { send } from "./host";

interface Props {
  state: ViewState;
  locale: Locale;
  open: boolean;
  onOpenChange(open: boolean): void;
}

const NEW = "__new__";

export function SettingsCard({ state, locale, open, onOpenChange }: Props) {
  const { profiles, activeProfileId, hermesConfig } = state.endpoint;
  const active = profiles.find((p) => p.id === activeProfileId) ?? profiles[0];
  const [selected, setSelected] = useState(activeProfileId);

  useEffect(() => {
    if (open) setSelected(activeProfileId);
  }, [open, activeProfileId]);

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
        <CustomProfileForm key={selected} profile={editing} locale={locale} state={state} onSaved={() => onOpenChange(false)} />
      )}

      {testLine}
      {approval}
      <McpSection state={state} locale={locale} />
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
      return <div className="approval-line ok">✓ {t(locale, "approval.active")}</div>;
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

function CustomProfileForm({ profile, locale, state, onSaved }: { profile?: ProfileView; locale: Locale; state: ViewState; onSaved(): void }) {
  const [name, setName] = useState(profile?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(profile?.baseUrl ?? "");
  const [model, setModel] = useState(profile?.model ?? "");
  const [apiKey, setApiKey] = useState("");
  const [removeKey, setRemoveKey] = useState(false);
  const [contextLength, setContextLength] = useState(profile?.contextLength ?? 0);
  const isActive = profile?.id === state.endpoint.activeProfileId;

  return (
    <>
      <p className="hint">{t(locale, "api.mode.customHint")}</p>
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
        <input className="mono" value={model} placeholder="model-name" spellCheck={false} onChange={(e) => setModel(e.target.value)} />
      </label>
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
