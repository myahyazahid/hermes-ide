// Claude-style composer menus: "/" commands and the approval mode picker.
import type { ReactNode } from "react";
import type { AgentMode } from "../../src/shared/protocol";
import { t, type Locale, type StringKey } from "../../src/shared/strings";

export interface MenuItem {
  id: string;
  section?: string;
  label: string;
  /** Right-aligned note, e.g. the current model. */
  hint?: string;
  description?: string;
  icon?: ReactNode;
  checked?: boolean;
  disabled?: boolean;
  run(): void;
}

export const MODES: AgentMode[] = ["manual", "acceptEdits", "plan", "ask", "auto", "superAuto"];

export const modeLabel = (mode: AgentMode, locale: Locale) => t(locale, `mode.${mode}` as StringKey);

export function nextMode(mode: AgentMode): AgentMode {
  return MODES[(MODES.indexOf(mode) + 1) % MODES.length];
}

export function MenuList({ items, active, onHover, label, header }: {
  items: MenuItem[];
  active: number;
  onHover(i: number): void;
  label: string;
  header?: ReactNode;
}) {
  let lastSection: string | undefined;
  return (
    <div className="menu" role="listbox" aria-label={label} onMouseDown={(e) => e.preventDefault()}>
      {header}
      {items.map((item, i) => {
        const heading = item.section && item.section !== lastSection ? item.section : undefined;
        lastSection = item.section;
        return (
          <div key={item.id}>
            {heading && <div className={`menu-section${i > 0 ? " sep" : ""}`}>{heading}</div>}
            <button
              type="button"
              role="option"
              aria-selected={i === active}
              disabled={item.disabled}
              className={`menu-item${i === active ? " on" : ""}${item.description ? " tall" : ""}`}
              onMouseEnter={() => onHover(i)}
              onClick={() => item.run()}
            >
              {item.icon && <span className="menu-icon" aria-hidden>{item.icon}</span>}
              <span className="menu-text">
                <span className="menu-label">{item.label}</span>
                {item.description && <span className="menu-desc">{item.description}</span>}
              </span>
              {item.hint && <span className="menu-hint">{item.hint}</span>}
              {item.checked && <span className="menu-check" aria-hidden>✓</span>}
            </button>
          </div>
        );
      })}
    </div>
  );
}

const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

export function ModeIcon({ mode, size = 16 }: { mode: AgentMode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden {...stroke}>
      {mode === "manual" && <path d="M5.5 8V3.2a1 1 0 0 1 2 0V7m0-.5V2.5a1 1 0 0 1 2 0V7m0-3a1 1 0 0 1 2 0v3.5m0-2a1 1 0 0 1 2 0V10a4.5 4.5 0 0 1-4.5 4.5h-.3A4.5 4.5 0 0 1 4.6 13L2.8 10a1 1 0 0 1 1.6-1.2L5.5 10" />}
      {mode === "acceptEdits" && <path d="M5.5 4 2 8l3.5 4M10.5 4 14 8l-3.5 4" />}
      {mode === "plan" && <path d="M4 2.5h6.5L13 5v8.5H4zM6 7h5M6 9.5h5M6 12h3" />}
      {mode === "ask" && <path d="M2.5 3.5h11v7.5H7l-3 2.5V11H2.5zM6.6 5.9a1.5 1.5 0 1 1 1.9 1.4c-.4.1-.5.4-.5.8M8 9.4v.1" />}
      {mode === "auto" && <path d="M9 1.8 3.5 9h4L7 14.2 12.5 7h-4z" />}
      {mode === "superAuto" && <path d="M7 1.8 2 9h3.6L5 14.2 10.2 7H6.6zM12.5 2v4M10.5 4h4M12.5 9.5v3M11 11h3" />}
    </svg>
  );
}

export function PlusIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden {...stroke}>
      <path d="M8 2.5v11M2.5 8h11" />
    </svg>
  );
}

export function SlashIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden {...stroke}>
      <rect x="2" y="2" width="12" height="12" rx="2.5" />
      <path d="M9.6 4.8 6.4 11.2" />
    </svg>
  );
}
