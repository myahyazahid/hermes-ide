// "Alat Hermes" (phase 6): the memory editor, the skills gallery and the parallel agent tasks. Each section asks the
// host for its data when it is opened and listens for the answers; nothing is loaded while the card is closed.
import { useEffect, useState, type ReactNode } from "react";
import type { DeployPanel, DeployTargetView, HostToView, MemoryPanel, MemoryTarget, SkillsPanel, StackView, TasksPanel, TaskView, ViewState } from "../../src/shared/protocol";
import { STACKS } from "../../src/shared/stacks";
import { t, type Locale, type StringKey } from "../../src/shared/strings";
import { send } from "./host";

interface Panels {
  deploy: DeployPanel;
  memory: MemoryPanel;
  skills: SkillsPanel;
  tasks: TasksPanel;
}

/** The latest panel the host sent for `type`. */
function usePanel<K extends keyof Panels>(type: K): Panels[K] | undefined {
  const [panel, setPanel] = useState<Panels[K]>();
  useEffect(() => {
    const onMessage = (event: MessageEvent<HostToView>) => {
      const msg = event.data;
      if (msg.type === type) setPanel((msg as unknown as { panel: Panels[K] }).panel);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [type]);
  return panel;
}

/** A section that loads its data the first time (and every time) it is opened. */
function Section({ className, title, onOpen, children }: { className: string; title: ReactNode; onOpen(): void; children: ReactNode }) {
  return (
    <details className={`tool ${className}`} onToggle={(e) => { if ((e.currentTarget as HTMLDetailsElement).open) onOpen(); }}>
      <summary>{title}</summary>
      {children}
    </details>
  );
}

export function ToolsCard({ state, locale }: { state: ViewState; locale: Locale }) {
  return (
    <section className="tools-card">
      <h3>{t(locale, "tools.title")}</h3>
      <StacksSection stacks={state.stacks ?? []} locale={locale} />
      <DeploySection locale={locale} />
      <MemorySection locale={locale} />
      <SkillsSection locale={locale} />
      <TasksSection locale={locale} />
    </section>
  );
}

// ---- project templates ----------------------------------------------------------------------

const insertPrompt = (text: string) => window.dispatchEvent(new CustomEvent("hermes:insert", { detail: text }));

/** A quiet suggestion when the project looks like a supported stack whose rules are not in yet. */
export function StackBanner({ state, locale }: { state: ViewState; locale: Locale }) {
  const stack = (state.stacks ?? []).find((s) => s.detected && !s.added && !s.dismissed);
  if (!stack) return null;
  return (
    <div className="banner info stack-banner">
      <span>{t(locale, "stacks.banner", stack.label)}</span>
      <span className="row-actions">
        <button type="button" className="small" onClick={() => send({ type: "addStackRules", id: stack.id })}>{t(locale, "stacks.addRules")}</button>
        <button type="button" className="ghost small" onClick={() => send({ type: "dismissStack", id: stack.id })}>{t(locale, "stacks.later")}</button>
      </span>
    </div>
  );
}

function StacksSection({ stacks, locale }: { stacks: StackView[]; locale: Locale }) {
  return (
    <Section className="stacks" title={t(locale, "stacks.title")} onOpen={() => send({ type: "loadStacks" })}>
      <p className="hint">{t(locale, "stacks.hint")}</p>
      <ul className="tool-list">
        {STACKS.map((info) => {
          const view = stacks.find((s) => s.id === info.id);
          return (
            <li key={info.id}>
              <div className="tool-main">
                <strong>{info.label}</strong>{" "}
                {view?.detected && <span className="chip ok">{t(locale, "stacks.detected")}</span>}{" "}
                {view?.added && <span className="chip">{t(locale, "stacks.added")}</span>}
              </div>
              <div className="row-actions">
                <button type="button" className="small" disabled={!!view?.added} onClick={() => send({ type: "addStackRules", id: info.id })}>{t(locale, "stacks.addRules")}</button>
                <button type="button" className="secondary small" onClick={() => insertPrompt(info.newProject[locale])}>{t(locale, "stacks.newProject")}</button>
              </div>
              <details className="stack-starters">
                <summary>{t(locale, "stacks.starters")}</summary>
                <ul className="starters">
                  {info.starters[locale].map((text) => (
                    <li key={text}><button type="button" className="starter" onClick={() => insertPrompt(text)}>{text}</button></li>
                  ))}
                </ul>
              </details>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

// ---- deploy ---------------------------------------------------------------------------------

const EMPTY_TARGET: DeployTargetView = { name: "", host: "", user: "" };

function DeploySection({ locale }: { locale: Locale }) {
  const panel = usePanel("deploy");
  const [editing, setEditing] = useState<{ original?: string; draft: DeployTargetView; port: string } | undefined>();
  const set = (patch: Partial<DeployTargetView>) => editing && setEditing({ ...editing, draft: { ...editing.draft, ...patch } });
  const field = (key: "name" | "host" | "user" | "identityFile" | "path" | "gitRemote", label: StringKey, placeholder = "") => (
    <label className="field">
      <span>{t(locale, label)}</span>
      <input className="mono" value={editing?.draft[key] ?? ""} placeholder={placeholder} spellCheck={false} onChange={(e) => set({ [key]: e.target.value })} />
    </label>
  );
  const save = () => {
    if (!editing) return;
    const d = editing.draft;
    const clean = (v?: string) => (v && v.trim() ? v.trim() : undefined);
    const port = editing.port.trim() ? Number(editing.port) : undefined;
    send({
      type: "saveDeployTarget",
      original: editing.original,
      target: { name: d.name.trim(), host: d.host.trim(), user: d.user.trim(), port: port as number | undefined, identityFile: clean(d.identityFile), path: clean(d.path), gitRemote: clean(d.gitRemote), steps: clean(d.steps) },
    });
    setEditing(undefined);
  };
  return (
    <Section className="deploy" title={t(locale, "deploy.title")} onOpen={() => send({ type: "loadDeploy" })}>
      <p className="hint">{t(locale, "deploy.hint")}</p>
      {panel?.blocked && <div className="tool-notice error">{panel.blocked}</div>}
      {panel?.notice && <div className={`tool-notice ${panel.notice.level}`}>{panel.notice.text}</div>}
      {panel && panel.targets.length === 0 && !editing && <p className="hint">{t(locale, "deploy.none")}</p>}
      <ul className="tool-list">
        {panel?.targets.map((target) => {
          const result = panel.results[target.name];
          return (
            <li key={target.name}>
              <div className="tool-main">
                <strong>{target.name}</strong> <span className="muted mono">{target.user}@{target.host}{target.port ? `:${target.port}` : ""}</span>
                {target.path && <div className="muted mono">{target.path}</div>}
                {panel.checking === target.name && <div className="muted">{t(locale, "deploy.testing")}</div>}
                {result && panel.checking !== target.name && <div className={`tool-notice ${result.ok ? "ok" : "error"}`}>{result.text}</div>}
              </div>
              <div className="row-actions">
                <button type="button" className="secondary small" disabled={!!panel.checking} onClick={() => send({ type: "testDeployTarget", name: target.name })}>{t(locale, "deploy.test")}</button>
                <button type="button" className="secondary small" onClick={() => send({ type: "openSshTerminal", name: target.name })}>{t(locale, "deploy.terminal")}</button>
                <button type="button" className="small" disabled={!!panel.blocked} onClick={() => send({ type: "prepareDeploy", name: target.name })}>{t(locale, "deploy.prepare")}</button>
                <button type="button" className="secondary small" onClick={() => setEditing({ original: target.name, draft: { ...target }, port: target.port ? String(target.port) : "" })}>{t(locale, "deploy.edit")}</button>
                <button type="button" className="secondary small" onClick={() => send({ type: "deleteDeployTarget", name: target.name })}>{t(locale, "deploy.delete")}</button>
              </div>
            </li>
          );
        })}
      </ul>
      {editing ? (
        <div className="deploy-form">
          {field("name", "deploy.f.name", "produksi")}
          {field("host", "deploy.f.host", "203.0.113.7")}
          {field("user", "deploy.f.user", "deploy")}
          <label className="field">
            <span>{t(locale, "deploy.f.port")}</span>
            <input className="mono" type="number" min={1} max={65535} value={editing.port} onChange={(e) => setEditing({ ...editing, port: e.target.value })} />
          </label>
          {field("identityFile", "deploy.f.key", "C:\\Users\\kamu\\.ssh\\id_ed25519")}
          <p className="hint">{t(locale, "deploy.keyNote")}</p>
          {field("path", "deploy.f.path", "/var/www/app")}
          {field("gitRemote", "deploy.f.gitRemote", "production")}
          <label className="field">
            <span>{t(locale, "deploy.f.steps")}</span>
            <textarea rows={4} value={editing.draft.steps ?? ""} onChange={(e) => set({ steps: e.target.value })} />
          </label>
          <div className="row-actions">
            <button type="button" className="small" onClick={save}>{t(locale, "deploy.save")}</button>
            <button type="button" className="secondary small" onClick={() => setEditing(undefined)}>{t(locale, "deploy.cancel")}</button>
          </div>
        </div>
      ) : (
        <div className="row-actions">
          <button type="button" className="secondary small" onClick={() => setEditing({ draft: { ...EMPTY_TARGET }, port: "" })}>{t(locale, "deploy.add")}</button>
          <button type="button" className="secondary small" onClick={() => send({ type: "showDeployHistory" })}>{t(locale, "deploy.history", panel?.historyCount ?? 0)}</button>
        </div>
      )}
    </Section>
  );
}

// ---- memory ---------------------------------------------------------------------------------

const DELIMITER_LENGTH = 3; // "\n§\n"
const joinedLength = (entries: string[]) => {
  const clean = entries.map((e) => e.trim()).filter(Boolean);
  return clean.join("").length + Math.max(clean.length - 1, 0) * DELIMITER_LENGTH;
};

function MemorySection({ locale }: { locale: Locale }) {
  const panel = usePanel("memory");
  return (
    <Section className="memory" title={t(locale, "memory.title")} onOpen={() => send({ type: "loadMemory" })}>
      <p className="hint">{t(locale, "memory.hint")}</p>
      {panel?.notice && <div className={`tool-notice ${panel.notice.level}`}>{panel.notice.text}</div>}
      {panel?.targets.map((target) => (
        <MemoryTargetEditor key={`${target.target}:${target.hash}`} target={target} locale={locale} />
      ))}
      {panel && <p className="hint mono">{t(locale, "memory.home", panel.home)}</p>}
      {panel?.notice?.level === "ok" && (
        <button type="button" className="secondary small" onClick={() => send({ type: "newSession" })}>
          {t(locale, "memory.newSession")}
        </button>
      )}
    </Section>
  );
}

function MemoryTargetEditor({ target, locale }: { target: MemoryPanel["targets"][number]; locale: Locale }) {
  const [entries, setEntries] = useState(target.entries);
  const used = joinedLength(entries);
  const dirty = JSON.stringify(entries.map((e) => e.trim()).filter(Boolean)) !== JSON.stringify(target.entries);
  const over = used > target.limit;
  const label: Record<MemoryTarget, StringKey> = { memory: "memory.memoryTitle", user: "memory.userTitle" };
  return (
    <fieldset className="memory-target" disabled={!target.enabled}>
      <legend>{t(locale, label[target.target])}</legend>
      {!target.enabled && <p className="hint">{t(locale, "memory.disabled")}</p>}
      {target.irregular && <p className="hint warn">{t(locale, "memory.irregular")}</p>}
      {entries.length === 0 && <p className="hint">{t(locale, "memory.empty")}</p>}
      {entries.map((entry, i) => (
        <div className="memory-entry" key={i}>
          <textarea
            rows={Math.min(Math.max(entry.split("\n").length, 2), 8)}
            value={entry}
            onChange={(e) => setEntries(entries.map((x, j) => (j === i ? e.target.value : x)))}
          />
          <button type="button" className="secondary small" onClick={() => setEntries(entries.filter((_, j) => j !== i))}>
            {t(locale, "memory.remove")}
          </button>
        </div>
      ))}
      <div className={`memory-usage${over ? " over" : ""}`}>
        {t(locale, "memory.used", used, target.limit)} {dirty && <span className="muted">· {t(locale, "memory.dirty")}</span>}
      </div>
      <div className="row-actions">
        <button type="button" className="secondary small" onClick={() => setEntries([...entries, ""])}>{t(locale, "memory.add")}</button>
        <button type="button" className="small" disabled={!dirty || over} onClick={() => send({ type: "saveMemory", target: target.target, entries, hash: target.hash })}>
          {t(locale, "memory.save")}
        </button>
        <button type="button" className="secondary small" onClick={() => send({ type: "loadMemory" })}>{t(locale, "memory.reload")}</button>
        <button type="button" className="secondary small" onClick={() => send({ type: "openMemoryFile", target: target.target })}>{t(locale, "memory.openFile")}</button>
      </div>
    </fieldset>
  );
}

// ---- skills ---------------------------------------------------------------------------------

function SkillsSection({ locale }: { locale: Locale }) {
  const panel = usePanel("skills");
  const [query, setQuery] = useState("");
  const busy = !!panel?.working;
  const search = () => query.trim() && send({ type: "searchSkills", query: query.trim() });
  return (
    <Section className="skills" title={t(locale, "skills.title")} onOpen={() => send({ type: "loadSkills" })}>
      <p className="hint">{t(locale, "skills.hint")}</p>
      {panel?.blocked && <div className="tool-notice error">{panel.blocked}</div>}
      {panel?.notice && <div className={`tool-notice ${panel.notice.level}`}>{panel.notice.text}</div>}
      <div className="row-actions">
        <input
          type="text"
          value={query}
          placeholder={t(locale, "skills.search")}
          disabled={!!panel?.blocked}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") search(); }}
        />
        <button type="button" className="small" disabled={busy || !!panel?.blocked || !query.trim()} onClick={search}>{t(locale, "skills.searchBtn")}</button>
      </div>
      {busy && <p className="hint">{t(locale, "skills.working")}</p>}
      {panel?.query !== undefined && (
        <>
          <h4>{t(locale, "skills.resultsTitle")}</h4>
          {panel.results.length === 0 && !busy && <p className="hint">{t(locale, "skills.noResults")}</p>}
          <ul className="tool-list">
            {panel.results.map((hit) => (
              <li key={hit.identifier}>
                <div className="tool-main">
                  <strong>{hit.name}</strong> <span className="chip">{hit.source}</span> {hit.trust && <span className="chip">{t(locale, "skills.trust", hit.trust)}</span>}
                  <div className="muted">{hit.description}</div>
                  <div className="muted mono">{hit.identifier}</div>
                </div>
                <div className="row-actions">
                  <button type="button" className="secondary small" disabled={busy} onClick={() => send({ type: "inspectSkill", identifier: hit.identifier })}>{t(locale, "skills.inspect")}</button>
                  <button type="button" className="small" disabled={busy} onClick={() => send({ type: "installSkill", identifier: hit.identifier, name: hit.name, source: hit.source, trust: hit.trust })}>
                    {t(locale, "skills.install")}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      <h4>{t(locale, "skills.installedTitle")}</h4>
      {panel && panel.installed.length === 0 && <p className="hint">{t(locale, "skills.none")}</p>}
      <ul className="tool-list">
        {panel?.installed.map((skill) => (
          <li className="row" key={`${skill.category}/${skill.name}`}>
            <div className="tool-main">
              <strong>{skill.name}</strong> <span className="chip">{skill.category || skill.source}</span> <span className="chip">{skill.source}</span>{" "}
              <span className="muted">{t(locale, skill.enabled ? "skills.enabled" : "skills.disabled")}</span>
            </div>
            {skill.source !== "local" && skill.source !== "builtin" && (
              <button type="button" className="secondary small" disabled={busy} onClick={() => send({ type: "uninstallSkill", name: skill.name })}>{t(locale, "skills.uninstall")}</button>
            )}
          </li>
        ))}
      </ul>
    </Section>
  );
}

// ---- parallel tasks -------------------------------------------------------------------------

function TasksSection({ locale }: { locale: Locale }) {
  const panel = usePanel("tasks");
  const [prompt, setPrompt] = useState("");
  const [allowCommands, setAllowCommands] = useState(false);
  const start = () => {
    if (!prompt.trim()) return;
    send({ type: "startTask", prompt: prompt.trim(), allowCommands });
    setPrompt("");
  };
  return (
    <Section className="tasks" title={t(locale, "tasks.title")} onOpen={() => send({ type: "loadTasks" })}>
      <p className="hint">{t(locale, "tasks.hint")}</p>
      {panel?.blocked && <div className="tool-notice error">{panel.blocked}</div>}
      {panel?.notice && <div className={`tool-notice ${panel.notice.level}`}>{panel.notice.text}</div>}
      <textarea rows={3} value={prompt} placeholder={t(locale, "tasks.prompt")} onChange={(e) => setPrompt(e.target.value)} />
      <label className="check">
        <input type="checkbox" checked={allowCommands} onChange={(e) => setAllowCommands(e.target.checked)} />
        {t(locale, "tasks.allowCommands")}
      </label>
      <div className="row-actions">
        <button type="button" className="small" disabled={!prompt.trim() || !!panel?.blocked} onClick={start}>{t(locale, "tasks.start")}</button>
      </div>
      {panel && panel.tasks.length === 0 && <p className="hint">{t(locale, "tasks.none")}</p>}
      <ul className="tool-list tasks-list">
        {panel?.tasks.map((task) => <TaskRow key={task.id} task={task} locale={locale} />)}
      </ul>
    </Section>
  );
}

function TaskRow({ task, locale }: { task: TaskView; locale: Locale }) {
  const live = task.status === "starting" || task.status === "running";
  return (
    <li className={`task ${task.status}`}>
      <div className="tool-main">
        <strong>{task.title}</strong> <span className={`chip status-${task.status}`}>{t(locale, `tasks.status.${task.status}` as StringKey)}</span>
        {task.applied && <span className="chip ok">{t(locale, "tasks.applied")}</span>}
        <div className="muted mono">{t(locale, "tasks.branch", task.branch)}</div>
        {live && <div className="muted">{task.activity ?? t(locale, "tasks.working")}</div>}
        {!live && (
          <div className="muted">{task.fileCount > 0 ? t(locale, "tasks.files", task.fileCount, task.additions, task.deletions) : t(locale, "tasks.noChanges")}</div>
        )}
        {task.files.length > 0 && !live && <div className="muted mono">{task.files.slice(0, 6).join(", ")}{task.fileCount > 6 ? ", …" : ""}</div>}
        {task.error && <div className="tool-notice error">{task.error}</div>}
        {task.summary && !live && <div className="task-summary">{task.summary}</div>}
        {task.deniedCount > 0 && (
          <details className="task-denied">
            <summary>{t(locale, "tasks.denied", task.deniedCount)}</summary>
            <ul>
              {task.denied.map((d, i) => (
                <li key={i}><span className="mono">{d.subject}</span> <span className="muted">— {t(locale, `tasks.deniedReason.${d.reason}` as StringKey)}</span></li>
              ))}
            </ul>
          </details>
        )}
      </div>
      <div className="row-actions">
        {live && <button type="button" className="secondary small" onClick={() => send({ type: "stopTask", id: task.id })}>{t(locale, "tasks.stop")}</button>}
        {!live && task.fileCount > 0 && <button type="button" className="secondary small" onClick={() => send({ type: "viewTaskChanges", id: task.id })}>{t(locale, "tasks.changes")}</button>}
        {task.hasChat && <button type="button" className="secondary small" onClick={() => send({ type: "openTaskChat", id: task.id })}>{t(locale, "tasks.chat")}</button>}
        {!live && task.fileCount > 0 && !task.applied && <button type="button" className="small" onClick={() => send({ type: "applyTask", id: task.id })}>{t(locale, "tasks.apply")}</button>}
        {!live && <button type="button" className="secondary small" onClick={() => send({ type: "openTaskFolder", id: task.id })}>{t(locale, "tasks.folder")}</button>}
        <button type="button" className="secondary small" onClick={() => send({ type: "discardTask", id: task.id })}>{t(locale, "tasks.discard")}</button>
      </div>
    </li>
  );
}
