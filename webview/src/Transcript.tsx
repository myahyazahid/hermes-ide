import { useEffect, useMemo, useRef, useState } from "react";
import type { PermissionAction, TranscriptItem } from "../../src/shared/protocol";
import { t, type Locale, type StringKey } from "../../src/shared/strings";
import { formatSeconds, formatTokens, shortPath, splitPath } from "./format";
import { send } from "./host";
import { renderMarkdown } from "./markdown";

type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;
type PermissionItem = Extract<TranscriptItem, { kind: "permission" }>;
type ThoughtItem = Extract<TranscriptItem, { kind: "thought" }>;
type UserItem = Extract<TranscriptItem, { kind: "user" }>;
/** A user message followed by everything the agent did in reply, drawn as one timeline. */
type Turn = { id: string; user?: UserItem; steps: TranscriptItem[] };

interface Props {
  items: TranscriptItem[];
  locale: Locale;
  cwd?: string;
  busy: boolean;
}

export function Transcript({ items, locale, cwd, busy }: Props) {
  const turns = useMemo(() => groupTurns(items), [items]);
  const end = useRef<HTMLDivElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // Follow the stream unless the user scrolled up to read.
  useEffect(() => {
    if (stick.current) end.current?.scrollIntoView({ block: "end" });
  }, [items, busy]);

  const onScroll = () => {
    const el = container.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  if (!items.length) {
    return (
      <div className="transcript empty" ref={container}>
        <div className="empty-state">
          <div className="empty-title">{t(locale, "empty.title")}</div>
          <p>{t(locale, "empty.hint")}</p>
        </div>
      </div>
    );
  }

  const lastId = items[items.length - 1]?.id;
  return (
    <div className="transcript" ref={container} onScroll={onScroll} role="log" aria-live="polite" aria-busy={busy}>
      {turns.map((turn, i) => {
        const waiting = busy && i === turns.length - 1;
        return (
          <div className="turn" key={turn.id}>
            {turn.user && <UserMessage item={turn.user} locale={locale} busy={busy} />}
            {(turn.steps.length > 0 || waiting) && (
              <div className="timeline">
                {turn.steps.map((step) => (
                  <Step key={step.id} item={step} locale={locale} cwd={cwd} active={busy && step.id === lastId} />
                ))}
                {waiting && <WaitingRow items={items} locale={locale} />}
              </div>
            )}
          </div>
        );
      })}
      <div ref={end} />
    </div>
  );
}

function groupTurns(items: TranscriptItem[]): Turn[] {
  const turns: Turn[] = [];
  for (const item of items) {
    if (item.kind === "user") turns.push({ id: item.id, user: item, steps: [] });
    else if (turns.length) turns[turns.length - 1].steps.push(item);
    else turns.push({ id: `pre-${item.id}`, steps: [item] });
  }
  return turns;
}

/** ACP reports no per-reply token count, so estimate from streamed text (~4 chars per token). */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function tokenLabel(n: number, locale: Locale): string {
  return t(locale, "tokens.estimate", formatTokens(n));
}

function clockTime(at: number, locale: Locale): string {
  return new Date(at).toLocaleTimeString(locale === "id" ? "id-ID" : "en-US", { hour: "numeric", minute: "2-digit" });
}

const SPARKLE = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];
const VERBS = [
  "Accomplishing", "Baking", "Booping", "Brewing", "Calculating", "Cerebrating", "Churning", "Coalescing",
  "Cogitating", "Computing", "Concocting", "Conjuring", "Contemplating", "Cooking", "Crafting", "Crunching",
  "Deciphering", "Deliberating", "Divining", "Elucidating", "Enchanting", "Envisioning", "Finagling", "Forging",
  "Germinating", "Hatching", "Hermesing", "Honking", "Hustling", "Ideating", "Imagining", "Incubating",
  "Inferring", "Manifesting", "Marinating", "Meandering", "Moseying", "Mulling", "Musing", "Noodling",
  "Percolating", "Pondering", "Puttering", "Reticulating", "Ruminating", "Scheming", "Shimmying", "Simmering",
  "Smooshing", "Spinning", "Stewing", "Synthesizing", "Tinkering", "Transmuting", "Unfurling", "Unravelling",
  "Vibing", "Whirring", "Wibbling", "Wizarding", "Wrangling",
];

function pickVerb(prev?: string): string {
  let next = prev;
  while (next === prev) next = VERBS[Math.floor(Math.random() * VERBS.length)];
  return next!;
}

/** Claude-style "Mulling…" row: shown for the whole turn unless the agent is waiting on a permission. */
function WaitingRow({ items, locale }: { items: TranscriptItem[]; locale: Locale }) {
  const blocked = items.some((i) => i.kind === "permission" && i.state === "pending");
  const lastUser = items.map((i) => i.kind).lastIndexOf("user");
  const streamed = items.slice(lastUser + 1).reduce((n, i) => n + (i.kind === "agent" || i.kind === "thought" ? estimateTokens(i.text) : 0), 0);
  const [since] = useState(Date.now());
  const [now, setNow] = useState(Date.now());
  const [frame, setFrame] = useState(0);
  const [verb, setVerb] = useState(() => pickVerb());

  useEffect(() => {
    const glyph = setInterval(() => setFrame((f) => (f + 1) % SPARKLE.length), 120);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    const words = setInterval(() => setVerb((v) => pickVerb(v)), 3500);
    return () => {
      clearInterval(glyph);
      clearInterval(clock);
      clearInterval(words);
    };
  }, []);

  if (blocked) return null;
  return (
    <div className="node waiting" role="status" aria-label={t(locale, "status.busy")}>
      <span className="waiting-glyph" aria-hidden>{SPARKLE[frame]}</span>
      <span key={verb} className="waiting-verb">{verb}…</span>
      <span className="waiting-meta">
        ({formatSeconds(now - since, locale)}
        {streamed > 0 && <> · ↓ {tokenLabel(streamed, locale)}</>})
      </span>
    </div>
  );
}

function UserMessage({ item, locale, busy }: { item: UserItem; locale: Locale; busy: boolean }) {
  return (
    <div className="user-turn">
      {item.at !== undefined && <div className="stamp">{clockTime(item.at, locale)}</div>}
      {item.context && item.context.length > 0 && (
        <div className="chips sent">
          {item.context.map((c) =>
            c.kind === "image" ? (
              <span key={c.label} className="chip image">
                <span className="mono">▣ {c.label}</span>
              </span>
            ) : c.kind === "rules" ? (
              <button key={`rules:${c.label}`} type="button" className="chip rules" title={t(locale, "rules.chipTitle", c.label)} onClick={() => send({ type: "openFile", path: c.path })}>
                <span className="mono">§ {c.label}</span>
              </button>
            ) : (
              <button key={c.label} type="button" className="chip" title={c.path} onClick={() => send({ type: "openFile", path: c.path })}>
                <span className="mono">@{c.label}</span>
              </button>
            ),
          )}
        </div>
      )}
      <div className="msg user">{item.text}</div>
      {item.restorable && item.turn !== undefined && (
        <button
          type="button"
          className="restore-btn"
          disabled={busy}
          title={item.ranCommands ? `${t(locale, "checkpoint.restoreTitle")}\n${t(locale, "checkpoint.ranCommand")}` : t(locale, "checkpoint.restoreTitle")}
          onClick={() => send({ type: "restoreCheckpoint", turn: item.turn! })}
        >
          ↩ {t(locale, "checkpoint.restore")}
          {item.ranCommands ? " ⚠" : ""}
        </button>
      )}
    </div>
  );
}

function Step({ item, locale, cwd, active }: { item: TranscriptItem; locale: Locale; cwd?: string; active: boolean }) {
  switch (item.kind) {
    case "user":
      return null;
    case "agent":
      return (
        <div className="node text">
          {item.at !== undefined && <div className="stamp">{clockTime(item.at, locale)}</div>}
          <AgentMessage text={item.text} streaming={item.streaming} />
        </div>
      );
    case "thought":
      return <ThoughtStep item={item} locale={locale} active={active} />;
    case "notice":
      return (
        <div className={`node notice-node ${item.level}`}>
          <div className={`notice ${item.level}`}>{item.text}</div>
        </div>
      );
    case "permission":
      return (
        <div className={`node perm ${item.state}`}>
          <PermissionCard item={item} locale={locale} cwd={cwd} />
        </div>
      );
    case "tool":
      return <ToolStep tool={item} locale={locale} cwd={cwd} />;
  }
}

function ThoughtStep({ item, locale, active }: { item: ThoughtItem; locale: Locale; active: boolean }) {
  const [open, setOpen] = useState(false);
  const secs = Math.max(1, Math.round(((item.endedAt ?? 0) - (item.startedAt ?? 0)) / 1000));
  const label = active
    ? `${t(locale, "thought.active")} · ${tokenLabel(estimateTokens(item.text), locale)}`
    : item.startedAt !== undefined
      ? t(locale, "thought.for", locale === "id" ? `${secs} dtk` : `${secs}s`)
      : t(locale, "thought");
  return (
    <div className="node thought">
      <button type="button" className={`thought-toggle${active ? " active" : ""}`} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {label}
      </button>
      {open && <div className="thought-text">{item.text}</div>}
    </div>
  );
}

function AgentMessage({ text, streaming }: { text: string; streaming: boolean }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    for (const pre of ref.current?.querySelectorAll("pre") ?? []) {
      if (pre.querySelector(".copy")) continue;
      const btn = document.createElement("button");
      btn.className = "copy";
      btn.type = "button";
      btn.textContent = "Copy";
      btn.setAttribute("aria-label", "Copy code");
      btn.addEventListener("click", () => void navigator.clipboard.writeText(pre.querySelector("code")?.textContent ?? ""));
      pre.appendChild(btn);
    }
  }, [html]);

  return <div ref={ref} className={`msg agent markdown${streaming ? " streaming" : ""}`} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** Claude-style tool names; titles like "skill_view: x" keep Hermes' own tool name. */
const KIND_NAME: Record<string, string> = {
  read: "Read", edit: "Edit", delete: "Delete", move: "Move", search: "Search", execute: "Bash", think: "Think", fetch: "Fetch",
};

function toolHeading(tool: ToolItem, cwd?: string): { name: string; desc: string } {
  const m = /^([\w.-]+):\s*([\s\S]*)$/.exec(tool.title);
  const name = tool.toolKind === "execute" ? KIND_NAME.execute : (m?.[1] ?? KIND_NAME[tool.toolKind] ?? "Tool");
  const rest = m ? m[2] : tool.title;
  const desc = tool.description ?? (tool.paths[0] && tool.toolKind !== "execute" ? shortPath(tool.paths[0], cwd) : rest);
  return { name, desc };
}

function ToolStep({ tool, locale, cwd }: { tool: ToolItem; locale: Locale; cwd?: string }) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const running = tool.status === "pending" || tool.status === "in_progress";

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [running]);

  const { name, desc } = toolHeading(tool, cwd);
  const meta =
    tool.added !== undefined || tool.removed !== undefined ? (
      <span className="stat">
        <span className="add">+{tool.added ?? 0}</span> <span className="del">-{tool.removed ?? 0}</span>
      </span>
    ) : tool.status === "failed" ? (
      t(locale, "tool.failed")
    ) : (
      formatSeconds((tool.endedAt ?? now) - tool.startedAt, locale)
    );
  const input = tool.input ?? "";
  const output = tool.detail ?? "";
  const long = input.includes("\n") || input.length > 80 || output.split("\n").length > 6;
  const path = tool.paths[0];

  // Clicking the box expands it, unless the user was selecting text to copy.
  const toggle = () => {
    if (long && !window.getSelection()?.toString()) setOpen((o) => !o);
  };

  return (
    <div className={`node tool ${tool.status}`}>
      <div className="tool-head" title={tool.title}>
        <span className="tool-name">{name}</span>
        {path && tool.toolKind !== "execute" ? (
          <button type="button" className="tool-desc link-like" onClick={() => send({ type: "openFile", path })}>
            {desc}
          </button>
        ) : (
          <span className="tool-desc">{desc}</span>
        )}
        <span className="tool-meta">{meta}</span>
      </div>
      {(input || output) && (
        <div className={`io${open ? " open" : ""}${long ? " long" : ""}`} onClick={toggle}>
          {input && (
            <div className="io-row">
              <span className="io-label">IN</span>
              <pre className="io-body in">{input}</pre>
            </div>
          )}
          {output && (
            <div className={`io-row out${tool.status === "failed" ? " failed" : ""}`}>
              <span className="io-label">OUT</span>
              <pre className="io-body">{output}</pre>
            </div>
          )}
          {long && <div className="io-more">{t(locale, open ? "tool.showLess" : "tool.showMore")}</div>}
        </div>
      )}
    </div>
  );
}

const ACTION_LABEL: Record<PermissionAction, StringKey> = {
  allow_once: "perm.allow",
  allow_session: "perm.allowSession",
  allow_always_ws: "perm.allowAlways",
  reject: "perm.reject",
  review: "perm.review",
};

/** Primary first, reject last, like Claude's approval prompt. */
const ACTION_ORDER: PermissionAction[] = ["allow_once", "review", "allow_session", "allow_always_ws", "reject"];

function PermissionCard({ item, locale, cwd }: { item: PermissionItem; locale: Locale; cwd?: string }) {
  const pending = item.state === "pending";
  const label = (a: PermissionAction) => t(locale, item.variant === "edit" && a === "allow_once" ? "perm.accept" : ACTION_LABEL[a]);
  const files = item.variant === "edit" ? (item.paths?.length ? item.paths : item.path ? [item.path] : []) : [];
  const actions = [...item.actions].sort((a, b) => ACTION_ORDER.indexOf(a) - ACTION_ORDER.indexOf(b));
  const openFile = (p: string) => {
    if (pending) send({ type: "permission", id: item.id, action: "review" });
    else if (/^([a-zA-Z]:|\/)/.test(p)) send({ type: "openFile", path: p });
  };

  return (
    <div className={`perm-card ${item.state} ${item.variant}`} role="group" aria-label={item.title}>
      <div className="perm-head">
        <span className="perm-icon" aria-hidden>
          <PermIcon variant={item.variant} />
        </span>
        <span className="perm-title">{item.title}</span>
        {item.added !== undefined && (
          <span className="stat">
            <span className="add">+{item.added}</span> <span className="del">-{item.removed ?? 0}</span>
          </span>
        )}
      </div>
      {item.command !== undefined && (
        <pre className="perm-command">
          <span className="prompt">$ </span>
          {item.command}
        </pre>
      )}
      {files.length > 0 && (
        <div className="perm-files">
          {files.map((p) => {
            const { name, dir } = splitPath(p, cwd);
            return (
              <button key={p} type="button" className="perm-file" title={p} onClick={() => openFile(p)}>
                <FileIcon />
                <span className="perm-file-name">{name}</span>
                {dir && <span className="perm-file-dir">{dir}</span>}
              </button>
            );
          })}
        </div>
      )}
      {item.why && (
        <div className="perm-why">
          <strong>🎓 {t(locale, "learning.why")}:</strong> {item.why}
        </div>
      )}
      {item.dangerReason && (
        <div className="perm-warning">
          <WarnIcon />
          <span>{item.dangerReason}</span>
        </div>
      )}
      {pending ? (
        <div className="perm-actions">
          {actions.map((a) => (
            <button
              key={a}
              type="button"
              className={`perm-btn ${a === "allow_once" ? "primary" : a === "reject" ? "reject" : "secondary"}`}
              onClick={() => send({ type: "permission", id: item.id, action: a })}
            >
              {label(a)}
              {item.variant === "edit" && a === "allow_once" && <kbd>Ctrl+Enter</kbd>}
            </button>
          ))}
          {item.resolution && <span className="perm-note">{item.resolution}</span>}
        </div>
      ) : (
        item.resolution && (
          <div className="perm-status">
            <span aria-hidden>{item.state === "allowed" ? "✓" : item.state === "rejected" ? "✕" : "–"}</span> {item.resolution}
          </div>
        )
      )}
    </div>
  );
}

function PermIcon({ variant }: { variant: PermissionItem["variant"] }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      {variant === "execute" && <path d="M2.5 3.5h11v9h-11zM5 7l2 1.5L5 10M8.5 10.5H11" />}
      {variant === "edit" && <path d="M10.8 2.7a1.5 1.5 0 0 1 2.1 2.1L6 11.7l-2.9.8.8-2.9zM9.6 3.9l2.1 2.1" />}
      {variant === "other" && <path d="M8 1.8 13 3.6v4c0 3-2.1 5.4-5 6.6-2.9-1.2-5-3.6-5-6.6v-4z" />}
    </svg>
  );
}

function FileIcon() {
  return (
    <svg className="perm-file-icon" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden>
      <path d="M4 1.8h5.2L12.5 5v9.2H4zM9 1.8V5.2h3.5" />
    </svg>
  );
}

function WarnIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M8 2 14.5 13.5h-13zM8 6.5v3M8 11.6v.1" />
    </svg>
  );
}
