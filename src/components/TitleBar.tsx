import { tr, currentLanguage } from "../i18n/core.ts";
import { useLanguage } from "../i18n/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Bot,
  History,
  ListChecks,
  GitBranch,
  Settings,
  PanelBottom,
  PanelLeft,
  PanelLeftClose,
} from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAppStore } from "../store/useAppStore";
import { isImageFile } from "../lib/fs";
import { isWindows } from "../lib/platform";
import { ChatHeaderActions } from "./Panels/RightPanel";
import { PresentationMenu } from "./Editor/PresentationMenu";
import { commandKeyLabel } from "../lib/codemirror/keybindings";

/** Count words: CJK characters count individually, latin runs as words. */
function countWords(text: string): number {
  const cjk = (text.match(/[一-龥぀-ヿ가-힯]/g) || []).length;
  const words = (text.match(/[A-Za-z0-9]+/g) || []).length;
  return cjk + words;
}

/**
 * Custom window title bar. With macOS `titleBarStyle: "Overlay"` the native
 * title is hidden and the traffic lights overlay our content, so we paint the
 * top strip ourselves: the left zone matches the sidebar, the right zone
 * matches the editor. The whole bar is a `data-tauri-drag-region`, so dragging
 * it moves the window (and double-click maximizes).
 *
 * `leftWidth` is the current sidebar width (0 when collapsed/narrow) so the
 * two zones line up with the panes below.
 */
export function TitleBar({ leftWidth }: { leftWidth: number }) {
  useLanguage();
  const activeFilePath = useAppStore((s) => s.activeFilePath);
  const content = useAppStore((s) => s.content);
  const bottomPanelOpen = useAppStore((s) => s.bottomPanelOpen);
  const rightPanelOpen = useAppStore((s) => s.rightPanelOpen);
  const rightPanelWidth = useAppStore((s) => s.rightPanelWidth);
  const runPanelOpen = useAppStore((s) => s.runPanelOpen);
  const runPanelWidth = useAppStore((s) => s.runPanelWidth);
  const toggleBottomPanel = useAppStore((s) => s.toggleBottomPanel);
  const toggleRightPanel = useAppStore((s) => s.toggleRightPanel);
  const sidebarOpen = useAppStore((s) => s.sidebarOpen);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const workspacePath = useAppStore((s) => s.workspacePath);
  const gitInfo = useAppStore((s) => s.gitInfo);
  const syncState = useAppStore((s) => s.syncState);
  const lastSyncMessage = useAppStore((s) => s.lastSyncMessage);
  const lastSyncAt = useAppStore((s) => s.lastSyncAt);
  const syncNow = useAppStore((s) => s.syncNow);
  const openHistory = useAppStore((s) => s.openHistory);
  const openSettings = useAppStore((s) => s.openSettings);
  const setManualSyncOpen = useAppStore((s) => s.setManualSyncOpen);
  const setBranchManagerOpen = useAppStore((s) => s.setBranchManagerOpen);
  const branchTaskBusy = useAppStore((s) => s.branchTaskBusy);

  const words = activeFilePath ? countWords(content) : 0;

  // Measure the right zone so the editor area's real width (after subtracting
  // both right-side panels) decides what fits. As it narrows, the word count
  // and sync time drop out first, then the centered title.
  const zoneRef = useRef<HTMLDivElement>(null);
  const [zoneWidth, setZoneWidth] = useState(0);
  useLayoutEffect(() => {
    const el = zoneRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setZoneWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const editorWidth =
    zoneWidth -
    (rightPanelOpen ? rightPanelWidth : 0) -
    (runPanelOpen ? runPanelWidth : 0);
  // Thresholds leave breathing room rather than waiting for actual overflow:
  // a full row (toggle + title + count + time + panel buttons) wants ~550px, so
  // extras start dropping well before the row gets tight.
  const showWords = editorWidth >= 560;
  const showSyncTime = editorWidth >= 500;
  // As it narrows further the toggle cluster sheds buttons one by one, then
  // the title; the sidebar and AI toggles are the last ones standing.
  const showSyncBtn = editorWidth >= 390;
  const showTerminalBtn = editorWidth >= 340;

  // Keep the centered title clear of the macOS traffic lights (top-left ~78px)
  // when the sidebar is collapsed or too narrow to host them. Windows has no
  // traffic lights (its controls sit top-right), so no reserve needed.
  const TRAFFIC = 78;
  const rightPadLeft = isWindows ? 0 : Math.max(0, TRAFFIC - leftWidth);

  return (
    <div
      data-tauri-drag-region
      className="flex h-9 shrink-0 select-none items-stretch"
    >
      {/* Left zone — flows seamlessly into the sidebar header below (same bg,
          and a right border continuing the sidebar's divider). The traffic
          lights sit here. */}
      <div
        data-tauri-drag-region
        style={{
          width: leftWidth,
          background: "var(--sidebar-bg)",
          borderRight: "1px solid var(--border)",
        }}
      />

      {/* Right zone — same surface as the toolbar below, so the two rows read
          as one block. The single bottom border lives on the toolbar row. */}
      <div
        ref={zoneRef}
        data-tauri-drag-region
        className="relative flex flex-1 items-center backdrop-blur"
        style={{ background: "var(--toolbar-bg)", paddingLeft: rightPadLeft }}
      >
        {/* Sidebar toggle lives up here so the editor toolbar row stays clean. */}
        <button
          title={sidebarOpen ? tr("收起侧栏") : tr("展开侧栏")}
          onClick={toggleSidebar}
          className="ml-1.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors"
          style={{ color: "var(--text-muted)" }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "var(--hover)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          {sidebarOpen ? <PanelLeftClose size={15} /> : <PanelLeft size={15} />}
        </button>

        {/* Word count stays with the editor area — right-aligned, just left of
            the toggle group. */}
        {activeFilePath && showWords && (
          <span
            data-tauri-drag-region
            className="ml-auto whitespace-nowrap pl-3 pr-3 text-xs"
            style={{ color: "var(--text-muted)" }}
          >
            {words} {" "}{tr("词")}</span>
        )}

        {/* Panel toggles live over the editor area, left of the right-panel
            divider, so they keep their spot whether the AI panel is open. */}
        <div
          data-tauri-drag-region
          className={`flex shrink-0 items-center justify-end gap-0.5 self-stretch pr-2 ${
            activeFilePath && showWords ? "" : "ml-auto"
          }`}
        >
          {activeFilePath && <PresentationMenu />}
          {/* A local repo without a remote can still sync (local commits), and
              history needs only that local repo. With a file open, the history
              dialog includes current-file and global tabs; with no file open,
              it opens directly to global history. File-level diff/rollback is
              text-only, so the entry is disabled for images. */}
          {showSyncBtn && workspacePath && gitInfo?.isRepo && (
            <SyncMenu
              syncState={syncState}
              lastSyncMessage={lastSyncMessage}
              lastSyncAt={lastSyncAt}
              showTime={showSyncTime}
              hasRemote={!!gitInfo.remoteUrl}
              historyLabel={activeFilePath ? tr("历史记录") : tr("全局历史")}
              historyDisabled={!!activeFilePath && isImageFile(activeFilePath)}
              onSync={() => void syncNow()}
              onManualSync={() => setManualSyncOpen(true)}
              onHistory={openHistory}
              onBranches={() => setBranchManagerOpen(true)}
              onSettings={() => void openSettings("sync")}
              branchBusy={branchTaskBusy}
            />
          )}
          {showTerminalBtn && (
            <PanelToggle
              title={bottomPanelOpen ? tr("关闭终端") : tr("打开终端")}
              active={bottomPanelOpen}
              onClick={toggleBottomPanel}
            >
              <PanelBottom size={16} />
            </PanelToggle>
          )}
          <PanelToggle
            title={rightPanelOpen ? tr("关闭 AI 笔记助手") : tr("打开 AI 笔记助手")}
            active={rightPanelOpen}
            onClick={toggleRightPanel}
          >
            <Bot size={16} />
          </PanelToggle>
        </div>

        {/* Each right-side panel owns a matching title-bar strip. Their order
            mirrors App.tsx: run output beside the editor, AI at the far right. */}
        {runPanelOpen && (
          <div
            data-tauri-drag-region
            className={`flex shrink-0 items-center justify-end gap-0.5 self-stretch ${
              isWindows || rightPanelOpen ? "" : "pr-2"
            }`}
            style={{ width: runPanelWidth, paddingLeft: 8, borderLeft: "1px solid var(--border)" }}
          >
            {isWindows && !rightPanelOpen && <WindowControls />}
          </div>
        )}

        {rightPanelOpen && (
          <div
            data-tauri-drag-region
            className={`flex shrink-0 items-center justify-end gap-0.5 self-stretch ${
              isWindows ? "" : "pr-2"
            }`}
            style={{ width: rightPanelWidth, paddingLeft: 8, borderLeft: "1px solid var(--border)" }}
          >
            <ChatHeaderActions />
            {isWindows && <WindowControls />}
          </div>
        )}

        {/* Windows controls move into whichever open panel is rightmost. */}
        {isWindows && !rightPanelOpen && !runPanelOpen && <WindowControls />}
      </div>
    </div>
  );
}

/** Windows-style minimize / maximize-restore / close buttons, flush to the
 *  top-right corner. macOS never renders these (traffic lights instead). */
function WindowControls() {
  useLanguage();
  const [maximized, setMaximized] = useState(false);

  // Track maximize state so the middle button shows the right glyph, whether
  // the change came from our button, a drag-region double-click, or Win+↑.
  useEffect(() => {
    let win: ReturnType<typeof getCurrentWindow>;
    try {
      win = getCurrentWindow();
    } catch {
      return; // Not in a Tauri context (e.g. plain browser).
    }
    let alive = true;
    let unlisten: (() => void) | undefined;
    const refresh = () =>
      void win
        .isMaximized()
        .then((m) => {
          if (alive) setMaximized(m);
        })
        .catch(() => {});
    refresh();
    void win
      .onResized(refresh)
      .then((fn) => {
        if (alive) unlisten = fn;
        else fn();
      })
      .catch(() => {});
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  // No-op outside a Tauri context (plain-browser dev).
  const withWin = (act: (w: ReturnType<typeof getCurrentWindow>) => Promise<void>) => {
    try {
      void act(getCurrentWindow()).catch(() => {});
    } catch {}
  };
  return (
    <div className="ml-1 flex shrink-0 self-stretch">
      <CaptionButton title={tr("最小化")} onClick={() => withWin((w) => w.minimize())}>
        <svg width="10" height="10" viewBox="0 0 10 10">
          <path d="M0 5h10" stroke="currentColor" strokeWidth="1" />
        </svg>
      </CaptionButton>
      <CaptionButton
        title={maximized ? tr("还原") : tr("最大化")}
        onClick={() => withWin((w) => w.toggleMaximize())}
      >
        {maximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path d="M2.5 2.5V0.5h7v7h-2" stroke="currentColor" strokeWidth="1" />
            <rect x="0.5" y="2.5" width="7" height="7" stroke="currentColor" strokeWidth="1" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" strokeWidth="1" />
          </svg>
        )}
      </CaptionButton>
      <CaptionButton title={tr("关闭")} danger onClick={() => withWin((w) => w.close())}>
        <svg width="10" height="10" viewBox="0 0 10 10">
          <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" />
        </svg>
      </CaptionButton>
    </div>
  );
}

function CaptionButton({
  title,
  danger,
  onClick,
  children,
}: {
  title: string;
  danger?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  useLanguage();
  return (
    <button
      title={title}
      onClick={onClick}
      className="flex h-full w-[46px] items-center justify-center transition-colors"
      style={{ color: "var(--text-muted)" }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = danger ? "#e81123" : "var(--hover)";
        if (danger) e.currentTarget.style.color = "#fff";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
        e.currentTarget.style.color = "var(--text-muted)";
      }}
    >
      {children}
    </button>
  );
}

/** Git sync menu: last-sync time + an icon whose arrow rises while syncing,
 *  tinted red/amber on error/conflict. Clicking opens 立即同步, 手动同步 (pick
 *  files and message) and history. */
function SyncMenu({
  syncState,
  lastSyncMessage,
  lastSyncAt,
  showTime,
  hasRemote,
  historyLabel,
  historyDisabled,
  onSync,
  onManualSync,
  onHistory,
  onBranches,
  onSettings,
  branchBusy,
}: {
  syncState: "idle" | "syncing" | "success" | "conflict" | "error";
  lastSyncMessage: string | null;
  lastSyncAt: number | null;
  showTime: boolean;
  hasRemote: boolean;
  historyLabel: string;
  historyDisabled: boolean;
  onSync: () => void;
  onManualSync: () => void;
  onHistory: () => void;
  onBranches: () => void;
  onSettings: () => void;
  branchBusy: boolean;
}) {
  useLanguage();
  const shortcuts = useAppStore((s) => s.editorKeybindings);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!position) return;
    menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const closeOutside = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node) && !buttonRef.current?.contains(e.target as Node))
        setPosition(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setPosition(null);
        buttonRef.current?.focus();
      }
    };
    const close = () => setPosition(null);
    // Window capture: Tauri's drag-region handler stops mousedown at the document.
    window.addEventListener("mousedown", closeOutside, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("mousedown", closeOutside, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", close);
    };
  }, [position]);

  const syncing = syncState === "syncing";
  const color = syncing
    ? "var(--accent)"
    : syncState === "error"
      ? "var(--danger, #ef4444)"
      : syncState === "conflict"
        ? "#d97706"
        : "var(--text-muted)";
  const title = syncing
    ? tr("同步中…")
    : lastSyncMessage
      ? lastSyncMessage +
        (lastSyncAt ? `（${new Date(lastSyncAt).toLocaleTimeString(currentLanguage(), { hour12: false })}）` : "")
      : hasRemote
        ? tr("同步到远程仓库")
        : tr("同步到本地仓库");
  const timeLabel = syncing
    ? tr("同步中…")
    : lastSyncAt
      ? new Date(lastSyncAt).toLocaleTimeString(currentLanguage(), {
          hour12: false,
          hour: "2-digit",
          minute: "2-digit",
        })
      : null;

  const MENU_WIDTH = 280;
  const toggle = () => {
    if (position) return setPosition(null);
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect)
      setPosition({
        top: rect.bottom + 5,
        left: Math.max(8, Math.min(rect.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8)),
      });
  };
  const choose = (action: () => void) => {
    setPosition(null);
    action();
  };
  const itemClass =
    "flex w-full items-center gap-2.5 rounded-md px-3 py-1.5 text-left text-sm hover:bg-[var(--hover)] focus:bg-[var(--hover)] focus:outline-none disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent";

  return (
    <>
      {showTime && timeLabel && (
        <span
          data-tauri-drag-region
          title={title}
          className="whitespace-nowrap text-[11px] tabular-nums"
          style={{ color: syncing ? "var(--accent)" : "var(--text-muted)" }}
        >
          {timeLabel}
        </span>
      )}
      <button
        ref={buttonRef}
        title={title}
        aria-haspopup="menu"
        aria-expanded={!!position}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); toggle(); }
        }}
        className="flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--hover)]"
        style={{ color, background: position ? "var(--active)" : undefined }}
      >
        <SyncIcon size={15} active={syncing} />
      </button>
      {position && createPortal(
        <div
          ref={menuRef}
          role="menu"
          aria-label={tr("同步")}
          className="fixed z-[80] rounded-lg p-1 shadow-xl"
          style={{ ...position, width: MENU_WIDTH, background: "var(--bg-elev)", border: "1px solid var(--border)", color: "var(--text)" }}
          onKeyDown={(e) => {
            if (!["ArrowDown", "ArrowUp"].includes(e.key)) return;
            e.preventDefault();
            const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
            buttons[(index + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
          }}
        >
          <button role="menuitem" className={itemClass} disabled={syncing || branchBusy} onClick={() => choose(onSync)}>
            <SyncIcon size={15} active={syncing} />
            {syncing ? tr("同步中…") : tr("立即同步")}
            <span className="ml-auto whitespace-nowrap text-[11px] tabular-nums" style={{ color: "var(--text-muted)" }}>{commandKeyLabel("syncNow", shortcuts)}</span>
          </button>
          <button role="menuitem" className={itemClass} disabled={syncing || branchBusy} onClick={() => choose(onManualSync)}>
            <ListChecks size={15} />
            {tr("手动同步")}
            <span className="ml-auto whitespace-nowrap text-[11px] tabular-nums" style={{ color: "var(--text-muted)" }}>{commandKeyLabel("manualSync", shortcuts)}</span>
          </button>
          <button role="menuitem" className={itemClass} disabled={historyDisabled} onClick={() => choose(onHistory)}>
            <History size={15} />
            {historyLabel}
            <span className="ml-auto whitespace-nowrap text-[11px] tabular-nums" style={{ color: "var(--text-muted)" }}>{commandKeyLabel("openHistory", shortcuts)}</span>
          </button>
          <button role="menuitem" className={itemClass} disabled={syncing || branchBusy} onClick={() => choose(onBranches)}>
            <GitBranch size={15} />
            {tr("分支管理")}
            <span className="ml-auto whitespace-nowrap text-[11px] tabular-nums" style={{ color: "var(--text-muted)" }}>{commandKeyLabel("branchManager", shortcuts)}</span>
          </button>
          <button role="menuitem" className={itemClass} onClick={() => choose(onSettings)}>
            <Settings size={15} />
            {tr("同步设置")}
          </button>
        </div>,
        document.body,
      )}
    </>
  );
}

/**
 * Lucide's CloudUpload geometry, with the arrow split out so it can rise on
 * its own while syncing (the cloud stays put).
 */
function SyncIcon({ size, active }: { size: number; active: boolean }) {
  useLanguage();
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242" />
      <g className={active ? "sync-arrow-up" : undefined}>
        <path d="M12 13v8" />
        <path d="m8 17 4-4 4 4" />
      </g>
    </svg>
  );
}

function PanelToggle({
  title,
  active,
  onClick,
  children,
}: {
  title: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  useLanguage();
  return (
    <button
      title={title}
      onClick={onClick}
      className="flex h-7 w-7 items-center justify-center rounded-md transition-colors"
      style={{
        background: active ? "var(--active)" : "transparent",
        color: active ? "var(--accent)" : "var(--text-muted)",
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.background = "var(--hover)";
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.background = "transparent";
      }}
    >
      {children}
    </button>
  );
}
