import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Bot, History, PanelBottom, PanelLeft, PanelLeftClose } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAppStore } from "../store/useAppStore";
import { isImageFile } from "../lib/fs";
import { isWindows } from "../lib/platform";
import { SyncToast } from "./Toast";
import { ChatHeaderActions } from "./Panels/RightPanel";

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
  const activeFilePath = useAppStore((s) => s.activeFilePath);
  const content = useAppStore((s) => s.content);
  const bottomPanelOpen = useAppStore((s) => s.bottomPanelOpen);
  const rightPanelOpen = useAppStore((s) => s.rightPanelOpen);
  const rightPanelWidth = useAppStore((s) => s.rightPanelWidth);
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

  const words = activeFilePath ? countWords(content) : 0;

  // Measure the right zone so the editor area's real width (zone minus the AI
  // panel) decides what fits. As it narrows, the word count and sync time drop
  // out first, then the centered title — the toggle buttons never overlap.
  const zoneRef = useRef<HTMLDivElement>(null);
  const [zoneWidth, setZoneWidth] = useState(0);
  useLayoutEffect(() => {
    const el = zoneRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setZoneWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const editorWidth = zoneWidth - (rightPanelOpen ? rightPanelWidth : 0);
  // Thresholds leave breathing room rather than waiting for actual overflow:
  // a full row (toggle + title + count + time + 4 buttons) wants ~550px, so
  // extras start dropping well before the row gets tight.
  const showWords = editorWidth >= 560;
  const showSyncTime = editorWidth >= 500;
  // As it narrows further the toggle cluster sheds buttons one by one, then
  // the title; the sidebar toggle and the AI toggle are the last two standing.
  const showHistoryBtn = editorWidth >= 440;
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
          title={sidebarOpen ? "收起侧栏" : "展开侧栏"}
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
            {words} 词
          </span>
        )}

        {/* Panel toggles live over the editor area, left of the right-panel
            divider, so they keep their spot whether the AI panel is open. */}
        <div
          data-tauri-drag-region
          className={`flex shrink-0 items-center justify-end gap-0.5 self-stretch pr-2 ${
            activeFilePath && showWords ? "" : "ml-auto"
          }`}
        >
          {/* History needs only a local repo (no remote required). With a
              file open, the dialog includes current-file and global tabs; with
              no file open, it opens directly to global history. File-level
              diff/rollback is text-only, so images are excluded. */}
          {showHistoryBtn &&
            workspacePath &&
            gitInfo?.isRepo &&
            (!activeFilePath || !isImageFile(activeFilePath)) && (
              <PanelToggle
                title={
                  activeFilePath
                    ? "历史记录"
                    : "全局历史"
                }
                active={false}
                onClick={openHistory}
              >
                <History size={15} />
              </PanelToggle>
            )}
          {/* A local repo without a remote can still sync (local commits). */}
          {showSyncBtn && workspacePath && gitInfo?.isRepo && (
            /* relative wrapper: the sync-result bubble anchors right under
               the button. */
            <div className="relative flex items-center gap-1">
              <SyncButton
                syncState={syncState}
                lastSyncMessage={lastSyncMessage}
                lastSyncAt={lastSyncAt}
                showTime={showSyncTime}
                hasRemote={!!gitInfo.remoteUrl}
                onClick={() => void syncNow()}
              />
              <SyncToast />
            </div>
          )}
          {showTerminalBtn && (
            <PanelToggle
              title={bottomPanelOpen ? "关闭终端" : "打开终端"}
              active={bottomPanelOpen}
              onClick={toggleBottomPanel}
            >
              <PanelBottom size={16} />
            </PanelToggle>
          )}
          <PanelToggle
            title={rightPanelOpen ? "关闭 AI 笔记助手" : "打开 AI 笔记助手"}
            active={rightPanelOpen}
            onClick={toggleRightPanel}
          >
            <Bot size={16} />
          </PanelToggle>
        </div>

        {/* Strip above the AI panel: keeps the panel divider running unbroken
            from the very top, stays a drag region, and hosts the chat actions
            (new session / session history) while the panel is open. */}
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

        {/* Windows draws no native chrome (`decorations: false`), so the
            window controls live here at the top-right corner. With the AI
            panel open they move inside its strip above so the panel divider
            still runs unbroken to the top. */}
        {isWindows && !rightPanelOpen && <WindowControls />}
      </div>
    </div>
  );
}

/** Windows-style minimize / maximize-restore / close buttons, flush to the
 *  top-right corner. macOS never renders these (traffic lights instead). */
function WindowControls() {
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
      <CaptionButton title="最小化" onClick={() => withWin((w) => w.minimize())}>
        <svg width="10" height="10" viewBox="0 0 10 10">
          <path d="M0 5h10" stroke="currentColor" strokeWidth="1" />
        </svg>
      </CaptionButton>
      <CaptionButton
        title={maximized ? "还原" : "最大化"}
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
      <CaptionButton title="关闭" danger onClick={() => withWin((w) => w.close())}>
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

/** Git sync trigger: last-sync time + icon whose arrows flow while syncing,
 *  tinted red/amber on error/conflict. */
function SyncButton({
  syncState,
  lastSyncMessage,
  lastSyncAt,
  showTime,
  hasRemote,
  onClick,
}: {
  syncState: "idle" | "syncing" | "success" | "conflict" | "error";
  lastSyncMessage: string | null;
  lastSyncAt: number | null;
  showTime: boolean;
  hasRemote: boolean;
  onClick: () => void;
}) {
  const syncing = syncState === "syncing";
  const color = syncing
    ? "var(--accent)"
    : syncState === "error"
      ? "var(--danger, #ef4444)"
      : syncState === "conflict"
        ? "#d97706"
        : "var(--text-muted)";
  const title = syncing
    ? "同步中…"
    : lastSyncMessage
      ? lastSyncMessage +
        (lastSyncAt ? `（${new Date(lastSyncAt).toLocaleTimeString("zh-CN", { hour12: false })}）` : "")
      : hasRemote
        ? "同步到远程仓库"
        : "同步到本地仓库";
  const timeLabel = syncing
    ? "同步中…"
    : lastSyncAt
      ? new Date(lastSyncAt).toLocaleTimeString("zh-CN", {
          hour12: false,
          hour: "2-digit",
          minute: "2-digit",
        })
      : null;

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
        title={title}
        onClick={onClick}
        disabled={syncing}
        className="flex h-7 w-7 items-center justify-center rounded-md transition-colors"
        style={{ color }}
        onMouseEnter={(e) => {
          if (!syncing) e.currentTarget.style.background = "var(--hover)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "transparent";
        }}
      >
        <SyncIcon size={15} active={syncing} />
      </button>
    </>
  );
}

/**
 * Lucide's ArrowDownUp geometry, split into the two arrows so they can move
 * independently while syncing: the down arrow flows downward and the up arrow
 * upward, each fading at the edges (transfer feel, not a refresh spin).
 */
function SyncIcon({ size, active }: { size: number; active: boolean }) {
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
      <g className={active ? "sync-arrow-down" : undefined}>
        <path d="m3 16 4 4 4-4" />
        <path d="M7 20V4" />
      </g>
      <g className={active ? "sync-arrow-up" : undefined}>
        <path d="m21 8-4-4-4 4" />
        <path d="M17 4v16" />
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
