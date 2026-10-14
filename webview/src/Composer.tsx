// Composer with context chips, @-mentions (F-12), pasted images, "/" commands and approval modes.
import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type RefObject } from "react";
import type { ContextRef, MentionItem, ViewState } from "../../src/shared/protocol";
import { t, type Locale, type StringKey } from "../../src/shared/strings";
import { MenuList, ModeIcon, MODES, modeLabel, nextMode, PlusIcon, SlashIcon, type MenuItem } from "./ComposerMenus";
import { currentModelName, ModelPicker } from "./ModelPicker";
import { formatTokens, relativePath } from "./format";
import { send } from "./host";

interface Props {
  state: ViewState;
  locale: Locale;
  inputRef: RefObject<HTMLTextAreaElement>;
  chips: ContextRef[];
  setChips(update: (prev: ContextRef[]) => ContextRef[]): void;
  mention: { requestId: number; items: MentionItem[] } | undefined;
  onOpenSettings(): void;
}

/** "/" menu: opened by typing "/" first (filtered by what follows) or by the "/" button. */
type Menu = { source: "slash" | "button"; view: "root" | "modes" };

let nextRequestId = 1;

/** Reads a pasted image into a chip: base64 bytes plus its pixel size, like Claude's "image.png 547×690". */
function readImage(file: File, name: string): Promise<ContextRef> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const url = String(reader.result);
      const img = new Image();
      const done = () =>
        resolve({ kind: "image", path: name, mimeType: file.type, data: url.slice(url.indexOf(",") + 1), width: img.naturalWidth || undefined, height: img.naturalHeight || undefined });
      img.onload = done;
      img.onerror = done;
      img.src = url;
    };
    reader.readAsDataURL(file);
  });
}

/** "image.png", then "image (2).png", … so several pastes stay separate attachments. */
function uniqueName(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base;
  const dot = base.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [base.slice(0, dot), base.slice(dot)] : [base, ""];
  let n = 2;
  while (taken.includes(`${stem} (${n})${ext}`)) n++;
  return `${stem} (${n})${ext}`;
}

export function chipLabel(ref: ContextRef, cwd?: string): string {
  if (ref.kind === "codebase") return "codebase";
  if (ref.kind === "image") return ref.path;
  const name = ref.path.split(/[\\/]/).pop() ?? ref.path;
  if (ref.kind === "selection") return `${name} · ${ref.startLine}${ref.endLine && ref.endLine !== ref.startLine ? `-${ref.endLine}` : ""}`;
  const rel = relativePath(ref.path, cwd);
  return ref.kind === "folder" ? `${rel}/` : rel;
}

export function Composer({ state, locale, inputRef, chips, setChips, mention, onOpenSettings }: Props) {
  const [text, setText] = useState("");
  const [menu, setMenu] = useState<Menu>();
  const [modeOpen, setModeOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [menuActive, setMenuActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState<{ value: string; start: number; requestId: number } | undefined>();
  const [active, setActive] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  // While the agent works, sending queues the message for when the turn ends.
  const canSend = (state.busy || ["ready", "stopped", "crashed"].includes(state.phase)) && text.trim().length > 0;
  const queued = state.queued ?? [];
  const results = query && mention?.requestId === query.requestId ? mention.items : undefined;

  const submit = useCallback(() => {
    if (!canSend) return;
    send({ type: "send", text, context: chips });
    setText("");
    setChips(() => []);
    setQuery(undefined);
  }, [canSend, text, chips, setChips]);

  const closeMenus = (clearSlash = true) => {
    if (clearSlash && menu?.source === "slash") setText("");
    setMenu(undefined);
    setModeOpen(false);
    setModelOpen(false);
  };
  const run = (fn: () => void) => () => {
    closeMenus();
    fn();
    inputRef.current?.focus();
  };
  const openView = (view: Menu["view"]) => () => {
    setMenu((m) => ({ source: m?.source ?? "button", view }));
    setMenuActive(0);
  };

  const modeItems: MenuItem[] = MODES.map((m) => ({
    id: `mode-${m}`,
    label: modeLabel(m, locale),
    description: t(locale, `mode.${m}.desc` as StringKey),
    icon: <ModeIcon mode={m} />,
    checked: state.mode === m,
    run: run(() => send({ type: "setMode", mode: m })),
  }));
  const back: MenuItem = { id: "back", label: `← ${t(locale, "cmd.back")}`, run: openView("root") };
  const currentModel = currentModelName(state);
  const ctx = t(locale, "cmd.section.context");
  const rootItems: MenuItem[] = [
    { id: "attach", section: ctx, label: t(locale, "cmd.attach"), run: run(() => send({ type: "attachFile" })) },
    {
      id: "mention", section: ctx, label: t(locale, "cmd.mention"),
      run: () => {
        closeMenus(false);
        const base = menu?.source === "slash" ? "" : text;
        const next = base + (base && !/\s$/.test(base) ? " @" : "@");
        setText(next);
        updateMention(next, next.length);
        requestAnimationFrame(() => {
          inputRef.current?.focus();
          inputRef.current?.setSelectionRange(next.length, next.length);
        });
      },
    },
    { id: "clear", section: ctx, label: t(locale, "cmd.clear"), disabled: state.busy, run: run(() => send({ type: "newSession" })) },
    { id: "export", section: ctx, label: t(locale, "cmd.export"), run: run(() => send({ type: "exportConversation" })) },
    { id: "history", section: t(locale, "cmd.section.session"), label: t(locale, "cmd.history"), run: run(() => window.dispatchEvent(new Event("hermes:history"))) },
    {
      id: "model", section: t(locale, "cmd.section.model"), label: t(locale, "cmd.switchModel"), hint: currentModel,
      disabled: state.busy || state.models.length === 0,
      run: () => {
        closeMenus();
        setModelOpen(true);
      },
    },
    { id: "mode", section: t(locale, "cmd.section.model"), label: t(locale, "cmd.mode"), hint: modeLabel(state.mode, locale), run: openView("modes") },
    { id: "settings", section: t(locale, "cmd.section.hermes"), label: t(locale, "cmd.settings"), run: run(onOpenSettings) },
    { id: "rules", section: t(locale, "cmd.section.hermes"), label: t(locale, "cmd.rules"), hint: state.rules ? state.rules.files.length.toString() : undefined, run: run(() => send({ type: "openRules" })) },
    { id: "usage", section: t(locale, "cmd.section.hermes"), label: t(locale, "cmd.usage"), run: run(() => send({ type: "showUsage" })) },
    { id: "learning", section: t(locale, "cmd.section.model"), label: t(locale, "cmd.learning"), hint: state.learning?.on ? "🎓" : undefined, run: run(() => send({ type: "setLearning", on: !state.learning?.on })) },
    { id: "privacyToggle", section: t(locale, "cmd.section.hermes"), label: t(locale, "cmd.privacyToggle"), hint: state.privacy?.localOnly ? "🔒" : undefined, run: run(() => send({ type: "setLocalOnly", enabled: !state.privacy?.localOnly })) },
    { id: "privacyReport", section: t(locale, "cmd.section.hermes"), label: t(locale, "cmd.privacyReport"), run: run(() => send({ type: "showPrivacy" })) },
    ...(state.canUndoRestore
      ? [{ id: "undoRestore", section: t(locale, "cmd.section.hermes"), label: t(locale, "cmd.undoRestore"), disabled: state.busy, run: run(() => send({ type: "undoRestore" })) }]
      : []),
    { id: "log", section: t(locale, "cmd.section.hermes"), label: t(locale, "action.showLog"), run: run(() => send({ type: "showLog" })) },
    { id: "restart", section: t(locale, "cmd.section.hermes"), label: t(locale, "action.restart"), run: run(() => send({ type: "restart" })) },
  ];
  const slashQuery = menu?.source === "slash" ? text.slice(1).toLowerCase() : "";
  const menuItems: MenuItem[] = modeOpen
    ? modeItems
    : !menu
      ? []
      : menu.view === "modes"
          ? [back, ...modeItems]
          : rootItems.filter((i) => !slashQuery || i.label.toLowerCase().includes(slashQuery));

  // Menus close on a click anywhere outside the composer.
  useEffect(() => {
    if (!menu && !modeOpen && !modelOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) {
        setMenu(undefined);
        setModeOpen(false);
        setModelOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [menu, modeOpen, modelOpen]);

  // Starter prompts from the quick-start card land in the box, ready to edit and send.
  useEffect(() => {
    const onInsert = (e: Event) => {
      setText(String((e as CustomEvent<string>).detail ?? ""));
      requestAnimationFrame(() => inputRef.current?.focus());
    };
    window.addEventListener("hermes:insert", onInsert);
    return () => window.removeEventListener("hermes:insert", onInsert);
  }, [inputRef]);

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

  // Ctrl+V with an image on the clipboard attaches it; plain text pastes as usual.
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...e.clipboardData.items].filter((i) => i.kind === "file" && i.type.startsWith("image/")).map((i) => i.getAsFile());
    const images = files.filter((f): f is File => !!f);
    if (!images.length) return;
    e.preventDefault();
    const taken = chips.filter((c) => c.kind === "image").map((c) => c.path);
    for (const file of images) {
      const ext = file.type.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
      const name = uniqueName(file.name && file.name !== "image.png" ? file.name : `image.${ext}`, taken);
      taken.push(name);
      void readImage(file, name).then((ref) => setChips((prev) => [...prev, ref]));
    }
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
    <div className="composer" ref={root}>
      {modelOpen && (
        <ModelPicker
          state={state}
          locale={locale}
          onClose={() => {
            setModelOpen(false);
            inputRef.current?.focus();
          }}
          onPick={(modelId) => {
            setModelOpen(false);
            if (modelId !== state.currentModelId) send({ type: "selectModel", modelId });
            inputRef.current?.focus();
          }}
        />
      )}
      {(menu || modeOpen) &&
        (menuItems.length ? (
          <MenuList
            items={menuItems}
            active={Math.min(menuActive, menuItems.length - 1)}
            onHover={setMenuActive}
            label={modeOpen ? t(locale, "mode.title") : t(locale, "composer.commands")}
            header={
              modeOpen ? (
                <div className="menu-head">
                  <span>{t(locale, "mode.title")}</span>
                  <span className="menu-head-hint">
                    <kbd>⇧</kbd> + <kbd>tab</kbd> {t(locale, "mode.switchHint")}
                  </span>
                </div>
              ) : undefined
            }
          />
        ) : (
          <div className="menu">
            <div className="menu-note">{t(locale, "composer.noMatches")}</div>
          </div>
        ))}
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
      {queued.length > 0 && (
        <div className="queue" role="list" aria-label={t(locale, "queue.title")}>
          <div className="queue-head">
            <span>{t(locale, state.busy ? "queue.title" : "queue.waiting")}</span>
            <button type="button" className="link-btn" onClick={() => send({ type: "sendQueued" })}>
              {t(locale, state.busy ? "queue.sendNow" : "queue.send")}
            </button>
          </div>
          {queued.map((q) => (
            <div key={q.id} className="queue-item" role="listitem">
              <span className="queue-text" title={q.text}>{q.text}</span>
              {q.attachments > 0 && <span className="queue-att">+{q.attachments}</span>}
              <button
                type="button"
                className="link-btn"
                onClick={() => {
                  setText((cur) => (cur.trim() ? `${q.text}\n\n${cur}` : q.text));
                  send({ type: "unqueue", id: q.id, edit: true });
                  inputRef.current?.focus();
                }}
              >
                {t(locale, "queue.edit")}
              </button>
              <button type="button" className="queue-x" aria-label={t(locale, "queue.remove")} title={t(locale, "queue.remove")} onClick={() => send({ type: "unqueue", id: q.id })}>
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      {chips.length > 0 && (
        <div className="chips">
          {chips.map((c, i) => {
            const label = chipLabel(c, state.cwd);
            return (
              <span key={`${c.kind}:${c.path}:${c.startLine ?? ""}`} className={`chip ${c.kind}`} title={c.path}>
                {c.kind === "image" && c.data && <img className="chip-thumb" src={`data:${c.mimeType};base64,${c.data}`} alt="" />}
                <span className="mono">{c.kind === "folder" ? "▸ " : c.kind === "codebase" ? "✦ " : ""}{label}</span>
                {c.kind === "image" && c.width && c.height && <span className="chip-dim">{c.width}×{c.height}</span>}
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
        placeholder={state.busy ? t(locale, "queue.placeholder") : `${t(locale, "composer.placeholder")} ${t(locale, "composer.mentionHint")}`}
        aria-label={t(locale, "composer.placeholder")}
        aria-autocomplete="list"
        onChange={(e) => {
          const value = e.target.value;
          setText(value);
          updateMention(value, e.target.selectionStart ?? value.length);
          if (/^\/\S*$/.test(value)) {
            setModeOpen(false);
            setMenu((m) => (m?.source === "slash" ? m : { source: "slash", view: "root" }));
            setMenuActive(0);
          } else if (menu?.source === "slash") {
            setMenu(undefined);
          }
        }}
        onKeyDown={(e) => {
          if (menu || modeOpen) {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              if (menuItems.length) setMenuActive((a) => (Math.min(a, menuItems.length - 1) + (e.key === "ArrowDown" ? 1 : menuItems.length - 1)) % menuItems.length);
              return;
            }
            if ((e.key === "Enter" && !e.shiftKey) || (e.key === "Tab" && !e.shiftKey)) {
              const item = menuItems[Math.min(menuActive, menuItems.length - 1)];
              if (item) {
                e.preventDefault();
                if (!item.disabled) item.run();
                return;
              }
            }
            if (e.key === "Escape") {
              e.preventDefault();
              closeMenus();
              return;
            }
          }
          if (e.key === "Tab" && e.shiftKey) {
            e.preventDefault();
            send({ type: "setMode", mode: nextMode(state.mode) });
            return;
          }
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
        onPaste={onPaste}
        onBlur={() => setTimeout(() => setQuery(undefined), 150)}
      />
      <div className="composer-bar">
        <button type="button" className="icon bar-btn" title={t(locale, "composer.attach")} aria-label={t(locale, "composer.attach")} onClick={() => send({ type: "attachFile" })}>
          <PlusIcon />
        </button>
        <button
          type="button"
          className={`icon bar-btn${menu ? " on" : ""}`}
          title={t(locale, "composer.commands")}
          aria-label={t(locale, "composer.commands")}
          aria-expanded={!!menu}
          onClick={() => {
            if (menu) return closeMenus();
            setModeOpen(false);
            setModelOpen(false);
            setMenu({ source: "button", view: "root" });
            setMenuActive(0);
            inputRef.current?.focus();
          }}
        >
          <SlashIcon />
        </button>
        <button
          type="button"
          className={`model-btn${modelOpen ? " on" : ""}`}
          title={state.models.find((m) => m.id === state.currentModelId)?.id ?? t(locale, "composer.model")}
          aria-label={t(locale, "composer.model")}
          aria-expanded={modelOpen}
          disabled={state.busy || state.phase !== "ready" || state.models.length === 0}
          onClick={() => {
            const next = !modelOpen;
            closeMenus(false);
            setModelOpen(next);
          }}
        >
          <span className="model-btn-name">{currentModelName(state) ?? t(locale, "composer.noModel")}</span>
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
            <path d="m4 6 4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {state.usage && state.usage.size > 0 && (
          <span className="usage" title={t(locale, "usage", state.usage.used, state.usage.size)}>
            {formatTokens(state.usage.used)} / {formatTokens(state.usage.size)}
          </span>
        )}
        <span className="spacer" />
        <button
          type="button"
          className={`mode-btn ${state.mode}${modeOpen ? " on" : ""}`}
          title={`${modeLabel(state.mode, locale)} — Shift+Tab`}
          aria-expanded={modeOpen}
          onClick={() => {
            setMenu(undefined);
            setModelOpen(false);
            setModeOpen((o) => !o);
            setMenuActive(MODES.indexOf(state.mode));
            inputRef.current?.focus();
          }}
        >
          <ModeIcon mode={state.mode} size={14} />
          <span>{modeLabel(state.mode, locale)}</span>
        </button>
        {state.busy && canSend && (
          <button type="button" className="send" onClick={submit} title={t(locale, "queue.add")} aria-label={t(locale, "queue.add")}>
            ↑
          </button>
        )}
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
