// Right-click menu for the editor surface: clipboard actions plus shortcuts
// into find/replace. Styled to match the sidebar's context menu.

import { useEffect, useRef } from "react";
import { selectAll } from "@codemirror/commands";
import { openSearchPanel } from "@codemirror/search";
import type { EditorView } from "@codemirror/view";

import { SubMenuItem } from "../ContextSubMenu";
import { getActiveView } from "../../lib/codemirror/activeView";
import { openSearchWithReplace } from "../../lib/codemirror/searchPanel";
import { copyText, readClipboardText } from "../../lib/clipboard";
import { codeBlockAt } from "../../lib/codeRun/document";
import { runInTerminal } from "../../lib/codeRun/run";

import {
  encryptInlineSelection,
  encryptSelection,
  lockNow,
} from "../../lib/crypto/commands";
import { useVaultStore } from "../../store/useVaultStore";

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
  // The right-click already moved the caret (see CodeMirrorEditor), so the
  // selection head tells us whether the click landed in a code block.
  const view = getActiveView();
  const block = view ? codeBlockAt(view, view.state.selection.main.head) : null;
  // An inline span cannot cross a line break, so the option is only offered
  // for a selection that already sits on one line.
  const selection = view?.state.selection.main;
  const canEncryptInline =
    menu.hasSelection &&
    !!view &&
    !!selection &&
    view.state.doc.lineAt(selection.from).number ===
      view.state.doc.lineAt(selection.to).number;
  const vaultOpen = useVaultStore((s) => !!s.status && !s.status.locked);

  // Dismiss on any click outside the menu, Escape, or window blur.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target;
      if (panelRef.current?.contains(target as Node)) return;
      // A submenu panel is portaled to <body>, so it is outside panelRef even
      // though it is part of this menu. Closing on its mousedown would unmount
      // the row before its own click could fire.
      if (target instanceof Element && target.closest("[data-menu-panel='true']"))
        return;
      onClose();
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
        // Seven rows at 32px, two dividers, and the panel's own padding —
        // measured, not guessed. Fixed now that the encryption entries are one
        // submenu row instead of two to four rows that came and went with the
        // vault's state. 在终端运行 adds a row and a divider.
        top: Math.min(menu.y, window.innerHeight - (block ? 294 : 252)),
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
      <div className="my-1" style={{ borderTop: "1px solid var(--border)" }} />
      {/* One row for the whole feature. The encryption entries laid out inline
          would outweigh cut/copy/paste in a menu that is mostly about the
          clipboard. */}
      <SubMenuItem label="加密">
        <Item
          disabled={!menu.hasSelection}
          onClick={() => run((v) => void encryptSelection(v))}
        >
          整块加密
        </Item>
        <Item
          disabled={!canEncryptInline}
          onClick={() => run((v) => void encryptInlineSelection(v))}
        >
          行内加密
        </Item>
        <div className="my-1" style={{ borderTop: "1px solid var(--border)" }} />
        <Item disabled={!vaultOpen} onClick={() => run((v) => void lockNow(v))}>
          立即上锁
        </Item>
      </SubMenuItem>
      {block && (
        <>
          <div className="my-1" style={{ borderTop: "1px solid var(--border)" }} />
          {/* The escape hatch for code the run pipeline can't host: anything
              needing stdin, a TTY, or a process that outlives the timeout. */}
          <Item onClick={() => run(() => void runInTerminal(block.info, block.code))}>
            在终端运行
          </Item>
        </>
      )}
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
