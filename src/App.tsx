import { useEffect, useRef, useState, useCallback } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";

import { Sidebar } from "./components/Sidebar/Sidebar";
import { Toolbar } from "./components/Editor/Toolbar";
import { EditorModeTabs } from "./components/Editor/EditorModeTabs";
import { EditorTabs } from "./components/Editor/EditorTabs";
import {
  CodeMirrorEditor,
  EmptyEditor,
} from "./components/Editor/CodeMirrorEditor";
import { ImageView } from "./components/Editor/ImageView";
import { FolderView } from "./components/Editor/FolderView";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { BottomPanel } from "./components/Panels/BottomPanel";
import { RightPanel } from "./components/Panels/RightPanel";
import { TitleBar } from "./components/TitleBar";
import { PromptModal } from "./components/PromptModal";
import { ConfirmModal } from "./components/ConfirmModal";
import { HistoryModal } from "./components/HistoryModal";
import { isDraftPath, useAppStore } from "./store/useAppStore";
import {
  basename,
  isImageFile,
  isMarkdownFile,
  pathIsDir,
  takePendingOpenFiles,
} from "./lib/fs";
import { openSearchPanel } from "@codemirror/search";
import { getActiveView } from "./lib/codemirror/activeView";
import { openSearchWithReplace } from "./lib/codemirror/searchPanel";

const MIN_W = 180;
const MAX_W = 480;
const RIGHT_PANEL_MIN_W = 220;
const RIGHT_PANEL_MAX_RATIO = 0.9;

/** Open a file handed over by the OS "Open With" menu as a new editor tab.
 *  Works whether or not a workspace is open (openFile doesn't need one); folders
 *  are skipped since the editor only opens files. */
async function openExternalFile(path: string) {
  if (await pathIsDir(path)) return;
  await useAppStore.getState().openFile(path);
}

function App() {
  const sidebarOpen = useAppStore((s) => s.sidebarOpen);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const activeFilePath = useAppStore((s) => s.activeFilePath);
  const folderViewPath = useAppStore((s) => s.folderViewPath);
  const bottomPanelOpen = useAppStore((s) => s.bottomPanelOpen);
  const toggleBottomPanel = useAppStore((s) => s.toggleBottomPanel);
  const rightPanelOpen = useAppStore((s) => s.rightPanelOpen);
  const rightPanelWidth = useAppStore((s) => s.rightPanelWidth);
  const setRightPanelWidth = useAppStore((s) => s.setRightPanelWidth);
  const docKey = useAppStore((s) => s.docKey);

  // The terminal panel stays mounted once opened so toggling it just hides the
  // panel (shells keep running); it's torn down only when its last tab closes.
  const [bottomPanelMounted, setBottomPanelMounted] = useState(false);
  useEffect(() => {
    if (bottomPanelOpen) setBottomPanelMounted(true);
  }, [bottomPanelOpen]);
  const save = useAppStore((s) => s.save);
  const restoreWorkspace = useAppStore((s) => s.restoreWorkspace);

  // What to show on launch: a workspace handed over in the URL (a folder sent
  // to a new window), the last workspace (original window only), or an empty
  // project (extra "main-N" windows opened blank).
  useEffect(() => {
    const win = getCurrentWindow();
    void (async () => {
      const ws = new URLSearchParams(window.location.search).get("ws");
      if (ws) {
        await useAppStore.getState().openWorkspaceAt(ws);
      } else if (win.label === "main") {
        await restoreWorkspace();
      }
      // Once the workspace (if any) has loaded, open files the app was launched
      // to open via the OS "Open With" menu — as new tabs in that workspace, or
      // in an empty project when none is open. Only the primary window drains.
      if (win.label !== "main") return;
      try {
        for (const p of await takePendingOpenFiles()) await openExternalFile(p);
      } catch {
        // No Tauri backend (e.g. running in a plain browser): nothing to drain.
      }
    })();
  }, [restoreWorkspace]);

  // Files opened via "Open With" while the app is already running arrive as an
  // "open-files" event from the Rust side. Handle them in the primary window.
  useEffect(() => {
    if (getCurrentWindow().label !== "main") return;
    const unlisten = listen<string[]>("open-files", (event) => {
      void (async () => {
        for (const p of event.payload) await openExternalFile(p);
      })();
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Pick up edits made to the open file by other programs: when the window
  // regains focus, stat it and reload if it changed on disk (silent when clean,
  // prompt when there are unsaved edits). No filesystem watcher, so focus is the
  // trigger. Runs in every editor window (App doesn't mount in the settings one).
  useEffect(() => {
    const unlisten = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (focused) void useAppStore.getState().checkExternalChange();
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Timed auto-sync (configured per workspace in 设置 → 远程同步). syncNow
  // already guards against re-entry and saves dirty edits first. A repo
  // without a remote still auto-syncs: each tick is a local commit snapshot.
  const workspacePath = useAppStore((s) => s.workspacePath);
  const syncConfig = useAppStore((s) => s.syncConfig);
  const gitSyncReady = useAppStore((s) => !!s.gitInfo?.isRepo);
  useEffect(() => {
    if (!workspacePath || !gitSyncReady || !syncConfig.autoSync) return;
    const id = setInterval(
      () => void useAppStore.getState().syncNow(),
      syncConfig.intervalMin * 60_000,
    );
    return () => clearInterval(id);
  }, [workspacePath, gitSyncReady, syncConfig.autoSync, syncConfig.intervalMin]);

  const [width, setWidth] = useState(260);
  const [narrow, setNarrow] = useState(window.innerWidth < 768);
  const [isDragging, setIsDragging] = useState(false);
  const dragging = useRef(false);

  // Global Ctrl/Cmd+S to save; Ctrl/Cmd+F (⌥ for replace) opens editor search
  // even when focus is elsewhere — except other text inputs (chat, terminal),
  // which keep their own keys. Ctrl/Cmd+Shift+F opens the sidebar global search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        save();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        useAppStore.getState().openGlobalSearch();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        const view = getActiveView();
        const t = e.target as HTMLElement | null;
        const inOtherInput =
          !!t &&
          !view?.dom.contains(t) &&
          (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
        if (view && !inOtherInput) {
          e.preventDefault();
          if (e.altKey) openSearchWithReplace(view);
          else openSearchPanel(view);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  // Files dragged in from the OS (Finder/Explorer) open in the editor. Tauri
  // delivers native drag-drop as webview events with bare paths, not HTML5
  // DataTransfer, so this is window-wide rather than a DOM drop target.
  const [dropHover, setDropHover] = useState(false);
  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent(async (event) => {
      if (event.payload.type === "enter") {
        setDropHover(true);
      } else if (event.payload.type === "leave") {
        setDropHover(false);
      } else if (event.payload.type === "drop") {
        setDropHover(false);
        const path = event.payload.paths[0];
        if (!path) return;
        if (await pathIsDir(path)) {
          window.alert(`「${basename(path)}」是文件夹，请拖入文件。`);
          return;
        }
        await useAppStore.getState().openFile(path);
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Suppress the webview's default right-click menu (Reload / Inspect Element)
  // on blank areas. The app's own context menus call preventDefault before this
  // bubble-phase listener runs, so they're unaffected; editable regions keep the
  // native menu so right-click copy/paste still works there.
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      if (e.defaultPrevented) return; // an app handler already took it
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable='true']")) return;
      e.preventDefault();
    };
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, []);

  // Track narrow viewport for responsive (mobile) drawer behavior.
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 768);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Sidebar drag-to-resize.
  const onMouseDown = useCallback(() => {
    dragging.current = true;
    setIsDragging(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      setWidth(Math.min(MAX_W, Math.max(MIN_W, e.clientX)));
    };
    const onUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      setIsDragging(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  const leftWidth = !narrow && sidebarOpen ? width : 0;

  const startRightPanelResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = useAppStore.getState().rightPanelWidth;
      const maxW = Math.max(
        RIGHT_PANEL_MIN_W,
        (window.innerWidth - leftWidth) * RIGHT_PANEL_MAX_RATIO,
      );
      const onMove = (ev: MouseEvent) => {
        setRightPanelWidth(
          Math.min(maxW, Math.max(RIGHT_PANEL_MIN_W, startW - (ev.clientX - startX))),
        );
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [leftWidth, setRightPanelWidth],
  );

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden">
      {/* Custom draggable title bar (native title is hidden). */}
      <TitleBar leftWidth={leftWidth} />

      <div className="relative flex min-h-0 flex-1">
      {/* Sidebar. Desktop: width collapses to 0 so the editor reclaims the
          space; the inner wrapper keeps a fixed width so content doesn't reflow
          mid-animation. Narrow: slides in/out as an overlay drawer. */}
      <div
        className={
          narrow
            ? "absolute z-40 h-full shadow-2xl transition-transform"
            : `relative shrink-0 overflow-hidden ${isDragging ? "" : "transition-[width] duration-200 ease-out"}`
        }
        style={{
          width: narrow ? width : sidebarOpen ? width : 0,
          transform: narrow
            ? `translateX(${sidebarOpen ? 0 : -width}px)`
            : undefined,
        }}
      >
        <div style={{ width }} className="h-full">
          <Sidebar />
        </div>
      </div>

      {/* Resize handle (desktop only): an invisible grab zone floated on the
          seam as an overlay, so the two panes stay flush — their bottom borders
          meet as one continuous line and the bg-color seam runs top to bottom. */}
      {!narrow && sidebarOpen && (
        <div
          onMouseDown={onMouseDown}
          className="absolute bottom-0 top-0 z-20 w-[6px] -translate-x-1/2 cursor-col-resize"
          style={{ left: leftWidth }}
          title="拖拽调整宽度"
        />
      )}

      {/* Backdrop for mobile drawer */}
      {narrow && sidebarOpen && (
        <div
          className="absolute inset-0 z-30 bg-black/30"
          onClick={toggleSidebar}
        />
      )}

      {/* Main editor pane */}
      <div className="relative flex min-w-0 flex-1 flex-col" style={{ background: "var(--bg)" }}>
        {dropHover && (
          <div
            className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center"
            style={{ background: "color-mix(in srgb, var(--accent) 8%, transparent)" }}
          >
            <span
              className="rounded-lg px-4 py-2 text-sm"
              style={{
                border: "1.5px dashed var(--accent)",
                color: "var(--accent)",
                background: "var(--bg)",
              }}
            >
              松开以打开文件
            </span>
          </div>
        )}
        <div className="flex min-h-0 flex-1 flex-col">
        <EditorTabs />
        {folderViewPath ? (
          <>
            <div
              className="flex h-11 items-center"
              style={{ borderBottom: "1px solid var(--border)" }}
            >
              <span
                className="ml-2 block truncate px-2 text-sm font-medium"
                style={{ color: "var(--text)" }}
              >
                {basename(folderViewPath)}
              </span>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">
              <FolderView path={folderViewPath} />
            </div>
          </>
        ) : activeFilePath ? (
          <>
            {/* Only markdown gets a header row (formatting toolbar + preview
                toggle). Other files rely on the tab strip for their name, so the
                editor/image fills the pane right under the tabs. */}
            {(isMarkdownFile(activeFilePath) || isDraftPath(activeFilePath)) && (
              <div
                className="flex h-11 items-center backdrop-blur"
                style={{
                  background: "var(--toolbar-bg)",
                  borderBottom: "1px solid var(--border)",
                }}
              >
                <div className="ml-2 min-w-0 flex-1">
                  <Toolbar />
                </div>
                <div className="mr-3 shrink-0">
                  <EditorModeTabs />
                </div>
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-hidden">
              {isImageFile(activeFilePath) ? (
                <ImageView path={activeFilePath} />
              ) : (
                // key forces a clean remount when switching files
                <ErrorBoundary resetKey={docKey}>
                  <CodeMirrorEditor key={docKey} />
                </ErrorBoundary>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="flex h-11 items-center" style={{ borderBottom: "1px solid var(--border)" }} />
            <div className="flex-1">
              <EmptyEditor />
            </div>
          </>
        )}
        </div>
        {bottomPanelMounted && (
          <BottomPanel
            visible={bottomPanelOpen}
            onAllClosed={() => {
              setBottomPanelMounted(false);
              if (bottomPanelOpen) toggleBottomPanel();
            }}
          />
        )}
      </div>
      {rightPanelOpen && (
        <div className="relative h-full shrink-0" style={{ width: rightPanelWidth }}>
          <div
            onMouseDown={startRightPanelResize}
            className="absolute bottom-0 left-0 top-0 z-30 w-[7px] -translate-x-1/2 cursor-col-resize"
            title="拖动调整宽度"
          />
          <RightPanel />
        </div>
      )}
      </div>

      <PromptModal />
      <ConfirmModal />
      <HistoryModal />
    </div>
  );
}

export default App;
