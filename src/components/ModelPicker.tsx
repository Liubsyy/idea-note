// Model picker grouped by config. The top level lists the configured providers
// ("A", "B", …); a config holding several model IDs opens a submenu with them,
// instead of flattening every config×model pair into one long list. A config
// with a single model selects it directly on click.
//
// Native <select> can't nest, so this is a custom menu portaled to <body> with
// fixed coordinates — its hosts (the chat composer, a settings row) are short,
// scrollable boxes that would clip an in-place panel.
//
// Two looks, same behaviour: `pill` for the AI assistant's composer (sized off
// the panel's own font) and `field` for a settings row (matching `Select`).

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, ChevronRight } from "lucide-react";

import type { AiModel } from "../lib/ai/types";
import { modelIdsOf, modelSelectionKey } from "../lib/ai/modelSelection";

type Variant = "pill" | "field";

const VARIANTS: Record<
  Variant,
  {
    /** Menus are portaled out of their host, so they carry their own font. */
    font: string;
    menuW: number;
    subW: number;
    subMaxH: number;
    /** Row height estimate, only used to pick the open direction. */
    rowH: number;
    rowClass: string;
    icon: number;
  }
> = {
  pill: {
    font: "calc(var(--ai-assistant-font-size) * 0.923)",
    menuW: 158,
    subW: 172,
    subMaxH: 236,
    rowH: 26,
    rowClass: "gap-1.5 px-2 py-1",
    icon: 11,
  },
  field: {
    font: "13px",
    menuW: 200,
    subW: 216,
    subMaxH: 260,
    rowH: 30,
    rowClass: "gap-2 px-2.5 py-1.5",
    icon: 12,
  },
};

export function ModelPicker({
  configs,
  value,
  onChange,
  label,
  variant = "pill",
  className,
  title = "选择模型",
}: {
  configs: AiModel[];
  /** Current `configId::modelId` selection key. */
  value: string;
  onChange: (key: string) => void;
  /** Text on the trigger — callers shorten it to taste. */
  label: string;
  variant?: Variant;
  className?: string;
  title?: string;
}) {
  const v = VARIANTS[variant];
  const [menu, setMenu] = useState<{
    left: number;
    /** Exactly one of these is set; the other stays undefined (auto). */
    top?: number;
    bottom?: number;
  } | null>(null);
  const [sub, setSub] = useState<{
    id: string;
    left: number;
    top?: number;
    bottom?: number;
  } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const subTimer = useRef<number | undefined>(undefined);

  const close = () => {
    window.clearTimeout(subTimer.current);
    setMenu(null);
    setSub(null);
  };

  // Grows downward when there's room below the trigger (a settings row), and
  // upward otherwise (the composer, which sits at the bottom of its panel).
  const opensUp = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return false;
    const below = window.innerHeight - r.bottom - 8;
    return below < Math.min(configs.length * v.rowH + 8, 320) && r.top > below;
  };

  const toggle = () => {
    if (menu) return close();
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    // Right-aligned to the trigger, then clamped inside the window.
    const left = Math.max(
      8,
      Math.min(r.right - v.menuW, window.innerWidth - v.menuW - 8),
    );
    setMenu(
      opensUp()
        ? { left, bottom: Math.max(8, window.innerHeight - r.top + 6) }
        : { left, top: Math.min(r.bottom + 6, window.innerHeight - 8) },
    );
  };

  // Dismiss on outside click / Escape / window blur. Both panels are portaled,
  // so `contains` on one ref isn't enough — they're tagged instead.
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.closest("[data-model-menu]") || el?.closest("[data-model-button]"))
        return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  useEffect(() => () => window.clearTimeout(subTimer.current), []);

  const openSub = (id: string, row: HTMLElement) => {
    window.clearTimeout(subTimer.current);
    const r = row.getBoundingClientRect();
    // Flip to the row's left when the submenu would run past the window edge —
    // with the picker docked right (the AI panel) that is the common case.
    const left = Math.max(
      8,
      r.right + v.subW + 8 > window.innerWidth ? r.left - v.subW + 2 : r.right - 2,
    );
    // Anchored to its own row and growing the same way the menu did, so a short
    // list stays beside the row it belongs to.
    setSub(
      menu?.bottom !== undefined
        ? { id, left, bottom: Math.max(8, window.innerHeight - r.bottom - 5) }
        : { id, left, top: Math.max(8, r.top - 5) },
    );
  };
  // Short delay so the pointer can cross the gap between row and submenu.
  const hideSub = () => {
    subTimer.current = window.setTimeout(() => setSub(null), 120);
  };
  const keepSub = () => window.clearTimeout(subTimer.current);

  const pick = (key: string) => {
    onChange(key);
    close();
  };

  const subConfig = sub ? configs.find((c) => c.id === sub.id) : null;
  const panelClass =
    "fixed overflow-y-auto overscroll-contain rounded-lg py-1 shadow-lg";
  const panelStyle = {
    background: "var(--bg-elev)",
    border: "1px solid var(--border)",
    boxShadow: "0 8px 24px var(--shadow)",
    fontSize: v.font,
  } as const;

  return (
    <>
      <button
        ref={btnRef}
        data-model-button="true"
        onClick={toggle}
        title={title}
        className={
          variant === "pill"
            ? `relative flex h-7 min-w-0 items-center overflow-hidden rounded-full pr-6 text-[0.923em] transition-colors ${className ?? ""}`
            : `relative flex h-8 min-w-0 items-center overflow-hidden rounded-lg pr-7 text-[13px] transition-colors ${className ?? ""}`
        }
        style={{
          background:
            variant === "pill"
              ? menu
                ? "var(--hover)"
                : "transparent"
              : "var(--bg)",
          border: `1px solid ${menu && variant === "field" ? "var(--accent)" : "var(--border)"}`,
          color: variant === "pill" ? "var(--text-soft)" : "var(--text)",
        }}
      >
        <span className="min-w-0 flex-1 truncate px-2 text-left">{label}</span>
        <ChevronDown
          size={13}
          className={`absolute shrink-0 opacity-75 ${variant === "pill" ? "right-2" : "right-2.5"}`}
        />
      </button>

      {menu &&
        createPortal(
          <div
            data-model-menu="true"
            className={`${panelClass} z-[70]`}
            style={{
              ...panelStyle,
              left: menu.left,
              top: menu.top,
              bottom: menu.bottom,
              width: v.menuW,
              maxHeight:
                menu.bottom !== undefined
                  ? `calc(100vh - ${menu.bottom + 8}px)`
                  : `calc(100vh - ${(menu.top ?? 0) + 8}px)`,
            }}
          >
            {configs.map((config) => {
              const ids = modelIdsOf(config);
              if (ids.length === 0) return null;
              const selected = ids.some(
                (id) => modelSelectionKey(config.id, id) === value,
              );
              if (ids.length === 1)
                return (
                  <MenuRow
                    key={config.id}
                    v={v}
                    label={config.label}
                    selected={selected}
                    onMouseEnter={() => setSub(null)}
                    onClick={() => pick(modelSelectionKey(config.id, ids[0]))}
                  />
                );
              return (
                <MenuRow
                  key={config.id}
                  v={v}
                  label={config.label}
                  hint={`${ids.length} 个模型`}
                  selected={selected}
                  active={sub?.id === config.id}
                  onMouseEnter={(e) => openSub(config.id, e.currentTarget)}
                  onMouseLeave={hideSub}
                  onClick={(e) => openSub(config.id, e.currentTarget)}
                />
              );
            })}
          </div>,
          document.body,
        )}

      {sub &&
        subConfig &&
        createPortal(
          <div
            data-model-menu="true"
            className={`${panelClass} z-[71]`}
            style={{
              ...panelStyle,
              left: sub.left,
              top: sub.top,
              bottom: sub.bottom,
              width: v.subW,
              maxHeight: Math.min(
                v.subMaxH,
                window.innerHeight - 8 - (sub.bottom ?? sub.top ?? 0),
              ),
            }}
            onMouseEnter={keepSub}
            onMouseLeave={hideSub}
          >
            {modelIdsOf(subConfig).map((id) => {
              const key = modelSelectionKey(subConfig.id, id);
              return (
                <MenuRow
                  key={key}
                  v={v}
                  label={id}
                  selected={key === value}
                  onClick={() => pick(key)}
                />
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}

function MenuRow({
  v,
  label,
  hint,
  selected,
  active,
  onClick,
  onMouseEnter,
  onMouseLeave,
}: {
  v: (typeof VARIANTS)[Variant];
  label: string;
  hint?: string;
  selected?: boolean;
  active?: boolean;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  onMouseEnter?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  onMouseLeave?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--hover)";
        onMouseEnter?.(e);
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = active ? "var(--hover)" : "transparent";
        onMouseLeave?.();
      }}
      className={`flex w-full items-center text-left transition-colors ${v.rowClass}`}
      style={{
        color: selected ? "var(--accent)" : "var(--text)",
        background: active ? "var(--hover)" : "transparent",
      }}
    >
      <span className="shrink-0" style={{ width: v.icon + 2 }}>
        {selected && <Check size={v.icon} />}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint && (
        <span className="shrink-0 text-[0.85em]" style={{ color: "var(--text-muted)" }}>
          {hint}
        </span>
      )}
      {hint && (
        <ChevronRight
          size={v.icon}
          className="shrink-0"
          style={{ color: "var(--text-muted)" }}
        />
      )}
    </button>
  );
}
