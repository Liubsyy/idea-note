// Right-click menu for the editor surface: clipboard actions plus shortcuts
// into find/replace. Styled to match the sidebar's context menu.

import { useEffect, useRef } from "react";
import { selectAll } from "@codemirror/commands";
import { openSearchPanel } from "@codemirror/search";
import type { EditorView } from "@codemirror/view";

import { getActiveView } from "../../lib/codemirror/activeView";
import { openSearchWithReplace } from "../../lib/codemirror/searchPanel";
import { copyText, readClipboardText } from "../../lib/clipboard";

export interface EditorMenuState {
  x: number;
  y: number;
  hasSelection: boolean;
}

const isMac = navigator.platform.toLowerCase().includes("mac");
const mod = isMac ? "⌘" : "Ctrl+";
const alt = isMac ? "⌥" : "Alt+";

/** Selected text across all ranges, multi-cursor ranges joined by newlines. */
function selectedText(view: EditorView): string {
  return view.state.selection.ranges
    .filter((r) => !r.empty)
    .map((r) => view.state.sliceDoc(r.from, r.to))
    .join("\n");
}

export function EditorContextMenu({
  menu,
  onClose,
}: {
  menu: EditorMenuState;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Dismiss on any click outside the menu, Escape, or window blur.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!panelRef.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  const run = (action: (view: EditorView) => void) => {
    onClose();
    const view = getActiveView();
    if (view) action(view);
  };

  const copy = (view: EditorView) => {
    void copyText(selectedText(view));
    view.focus();
  };
  const cut = (view: EditorView) => {
    void copyText(selectedText(view));
    view.dispatch(view.state.replaceSelection(""), { scrollIntoView: true });
    view.focus();
  };
  const paste = (view: EditorView) => {
    void readClipboardText().then((text) => {
      if (text) view.dispatch(view.state.replaceSelection(text), { scrollIntoView: true });
      view.focus();
    });
  };

  return (
    <div
      ref={panelRef}
      className="fixed z-50 w-44 rounded-lg py-1 text-sm shadow-lg"
      style={{
        left: Math.min(menu.x, window.innerWidth - 184),
        top: Math.min(menu.y, window.innerHeight - 218),
        background: "var(--bg-elev)",
        border: "1px solid var(--border)",
        boxShadow: "0 8px 24px var(--shadow)",
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <Item hint={`${mod}X`} disabled={!menu.hasSelection} onClick={() => run(cut)}>
        剪切
      </Item>
      <Item hint={`${mod}C`} disabled={!menu.hasSelection} onClick={() => run(copy)}>
        复制
      </Item>
      <Item hint={`${mod}V`} onClick={() => run(paste)}>
        粘贴
      </Item>
      <Item hint={`${mod}A`} onClick={() => run((v) => { selectAll(v); v.focus(); })}>
        全选
      </Item>
      <div className="my-1" style={{ borderTop: "1px solid var(--border)" }} />
      <Item hint={`${mod}F`} onClick={() => run((v) => openSearchPanel(v))}>
        查找
      </Item>
      <Item hint={`${alt}${mod}F`} onClick={() => run((v) => openSearchWithReplace(v))}>
        替换
      </Item>
    </div>
  );
}

function Item({
  onClick,
  children,
  hint,
  disabled,
}: {
  onClick: () => void;
  children: React.ReactNode;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left transition-colors disabled:cursor-default"
      style={{ color: "var(--text)", opacity: disabled ? 0.4 : 1 }}
      onMouseEnter={(e) => {
        if (!disabled) e.currentTarget.style.background = "var(--hover)";
      }}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint && (
        <span className="shrink-0 text-xs" style={{ color: "var(--text-muted)" }}>
          {hint}
        </span>
      )}
    </button>
  );
}
