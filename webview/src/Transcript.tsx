import { useEffect, useMemo, useRef, useState } from "react";
import type { PermissionAction, TranscriptItem } from "../../src/shared/protocol";
import { t, type Locale, type StringKey } from "../../src/shared/strings";
import { formatSeconds, relativePath } from "./format";
import { send } from "./host";
import { renderMarkdown } from "./markdown";

type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;
type PermissionItem = Extract<TranscriptItem, { kind: "permission" }>;
type Block = { type: "item"; item: TranscriptItem } | { type: "tools"; id: string; tools: ToolItem[] };

interface Props {
  items: TranscriptItem[];
  locale: Locale;
  cwd?: string;
  busy: boolean;
}

export function Transcript({ items, locale, cwd, busy }: Props) {
  const blocks = useMemo(() => groupTools(items), [items]);
  const end = useRef<HTMLDivElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // Follow the stream unless the user scrolled up to read.
  useEffect(() => {
    if (stick.current) end.current?.scrollIntoView({ block: "end" });
  }, [items]);

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

  return (
    <div className="transcript" ref={container} onScroll={onScroll} role="log" aria-live="polite" aria-busy={busy}>
      {blocks.map((b) =>
        b.type === "tools" ? (
          <ToolGroup key={b.id} tools={b.tools} locale={locale} cwd={cwd} />
        ) : (
          <ItemView key={b.item.id} item={b.item} locale={locale} cwd={cwd} />
        ),
      )}
      <div ref={end} />
    </div>
  );
}

function groupTools(items: TranscriptItem[]): Block[] {
  const out: Block[] = [];
  for (const item of items) {
    const last = out[out.length - 1];
    if (item.kind === "tool") {
      if (last?.type === "tools") last.tools.push(item);
      else out.push({ type: "tools", id: `tools-${item.id}`, tools: [item] });
    } else {
      out.push({ type: "item", item });
    }
  }
  return out;
}

function ItemView({ item, locale, cwd }: { item: TranscriptItem; locale: Locale; cwd?: string }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="user-turn">
          {item.context && item.context.length > 0 && (
            <div className="chips sent">
              {item.context.map((c) => (
                <button key={c.label} type="button" className="chip" title={c.path} onClick={() => send({ type: "openFile", path: c.path })}>
                  <span className="mono">@{c.label}</span>
                </button>
              ))}
            </div>
          )}
          <div className="msg user">{item.text}</div>
        </div>
      );
    case "agent":
      return <AgentMessage text={item.text} streaming={item.streaming} />;
    case "thought":
      return (
        <details className="thought">
          <summary>{t(locale, "thought")}</summary>
          <div className="thought-text">{item.text}</div>
        </details>
      );
    case "notice":
      return <div className={`notice ${item.level}`}>{item.text}</div>;
    case "permission":
      return <PermissionCard item={item} locale={locale} cwd={cwd} />;
    case "tool":
      return <ToolGroup tools={[item]} locale={locale} cwd={cwd} />;
  }
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

const KNOWN_KINDS = new Set(["read", "edit", "delete", "move", "search", "execute", "think", "fetch"]);

function ToolGroup({ tools, locale, cwd }: { tools: ToolItem[]; locale: Locale; cwd?: string }) {
  return (
    <div className="card tools" role="list">
      {tools.map((tool) => (
        <ToolRow key={tool.id} tool={tool} locale={locale} cwd={cwd} />
      ))}
    </div>
  );
}

function ToolRow({ tool, locale, cwd }: { tool: ToolItem; locale: Locale; cwd?: string }) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const running = tool.status === "pending" || tool.status === "in_progress";

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [running]);

  const verb = KNOWN_KINDS.has(tool.toolKind) ? t(locale, `tool.${tool.toolKind}` as StringKey) : "";
  const target = tool.paths[0] ? relativePath(tool.paths[0], cwd) : tool.title;
  const icon = tool.status === "completed" ? "✓" : tool.status === "failed" ? "✕" : "";
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

  const clickable = !!tool.detail || !!tool.paths[0];
  const onClick = () => {
    if (tool.detail) setOpen((o) => !o);
    else if (tool.paths[0]) send({ type: "openFile", path: tool.paths[0] });
  };

  return (
    <div className={`tool-row ${tool.status}`} role="listitem">
      <button className="tool-line" type="button" onClick={onClick} disabled={!clickable} title={tool.title} aria-expanded={tool.detail ? open : undefined}>
        <span className={`tool-icon ${tool.status}`} aria-hidden>{running ? <span className="spinner" /> : icon}</span>
        <span className="tool-verb">{verb || t(locale, "tool.other")}</span>
        <span className="tool-target">{verb ? target : tool.title}</span>
        <span className="tool-meta">{meta}</span>
      </button>
      {open && tool.detail && <pre className="tool-detail">{tool.detail}</pre>}
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

function PermissionCard({ item, locale, cwd }: { item: PermissionItem; locale: Locale; cwd?: string }) {
  const pending = item.state === "pending";
  const label = (a: PermissionAction) => t(locale, item.variant === "edit" && a === "allow_once" ? "perm.accept" : ACTION_LABEL[a]);

  return (
    <div className={`card permission ${item.state}`} role="group" aria-label={item.title}>
      <div className="perm-title">{item.title}</div>
      {item.command !== undefined && (
        <pre className="perm-command">
          <span className="prompt">$ </span>
          {item.command}
        </pre>
      )}
      {item.variant === "edit" && (
        <div className="perm-files">
          {(item.paths?.length ? item.paths : [item.path ?? ""]).map((p) => (
            <button key={p} type="button" className="link" onClick={() => send({ type: "permission", id: item.id, action: "review" })}>
              {relativePath(p, cwd)}
            </button>
          ))}
          {item.added !== undefined && (
            <span className="stat">
              <span className="add">+{item.added}</span> <span className="del">-{item.removed ?? 0}</span>
            </span>
          )}
        </div>
      )}
      {item.dangerReason && <div className="perm-warning">{item.dangerReason}</div>}
      {pending ? (
        <div className="perm-actions">
          {item.actions.map((a) => (
            <button
              key={a}
              type="button"
              className={a === "allow_once" ? "primary" : a === "reject" ? "ghost" : "secondary"}
              onClick={() => send({ type: "permission", id: item.id, action: a })}
            >
              {label(a)}
              {item.variant === "edit" && a === "allow_once" && <kbd>Ctrl+Enter</kbd>}
            </button>
          ))}
          {item.resolution && <span className="perm-note">{item.resolution}</span>}
        </div>
      ) : (
        <div className="perm-resolution">{item.resolution}</div>
      )}
    </div>
  );
}
