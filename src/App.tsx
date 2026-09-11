import {
  useEffect,
  useRef,
  useState,
  useCallback,
  type CSSProperties,
} from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { PhysicalPosition } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";

import { lockNow } from "./lib/crypto/commands";
import { VAULT_LOCK_REQUEST } from "./store/useVaultStore";
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
import { PresentationControls } from "./components/Editor/PresentationControls";
import { SlidePresentation } from "./components/Editor/SlidePresentation";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { BottomPanel } from "./components/Panels/BottomPanel";
import { RightPanel } from "./components/Panels/RightPanel";
import { RunPanel } from "./components/Panels/RunOutputPanel";
import { TitleBar } from "./components/TitleBar";
import { PromptModal } from "./components/PromptModal";
import { ConfirmModal } from "./components/ConfirmModal";
import { VaultModal } from "./components/VaultModal";
import { HistoryModal } from "./components/HistoryModal";
import { AppToast } from "./components/Toast";
import {
  isDraftPath,
  PRESENTATION_SCALE_DEFAULT,
  PRESENTATION_SCALE_STEP,
  useAppStore,
} from "./store/useAppStore";
import {
  basename,
  isImageFile,
  isMarkdownFile,
  pathIsDir,
  saveFileToDir,
  takePendingOpenFiles,
} from "./lib/fs";
import { runScopeHandlers, type EditorView } from "@codemirror/view";
import { getActiveView } from "./lib/codemirror/activeView";
import { handleEditorDrop } from "./lib/attachments";
import { setFileDropCursor } from "./lib/codemirror/fileDropCursor";
import { isWindows } from "./lib/platform";
import { createSidebarDropFeedback, sidebarDropTarget } from "./lib/sidebarDrop";

const MIN_W = 180;
const MAX_W = 480;
const RIGHT_PANEL_MIN_W = 220;
const EDITOR_MIN_W = 180;

/** Open a file handed over by the OS "Open With" menu as a new editor tab.
 *  Works whether or not a workspace is open (openFile doesn't need one); folders
 *  are skipped since the editor only opens files. */
async function openExternalFile(path: string) {
  if (await pathIsDir(path)) return;
  await useAppStore.getState().openFile(path);
}

/**
 * A native drop point in CSS pixels.
 *
 * Tauri hands every platform's coordinate over as a `PhysicalPosition`, but wry
 * doesn't measure them the same way: Windows reports device pixels (a
 * `ScreenToClient` point), while macOS reports AppKit points — `draggingLocation`
 * flipped against the webview frame — and GTK its own logical units. Neither of
 * the latter two is touched by page zoom, which is how applyZoom scales the UI
 * (`setZoom`, the webview's native zoom). `devicePixelRatio` folds the display
 * scale and that zoom together, so it converts the Windows flavour and only
 * that one; elsewhere the divisor is the UI zoom alone. Dividing by the wrong
 * one lands the hit test up and to the left of where the file was released —
 * half a window off on a Retina screen.
 */
function dropPoint(position: PhysicalPosition): { x: number; y: number } {
  const divisor = isWindows
    ? window.devicePixelRatio
    : useAppStore.getState().uiZoom || 1;
  return { x: position.x / divisor, y: position.y / divisor };
}

/** The element under a native drop point. Tauri reports a coordinate instead of
 *  delivering a DOM event, so the target is found by hit test; the drop overlay
 *  is pointer-events-none and so never shadows what's beneath. */
function elementAtDrop(position: PhysicalPosition): Element | null {
  const { x, y } = dropPoint(position);
  return document.elementFromPoint(x, y);
}

/** The markdown editor a drop landed in, or null when it landed anywhere else.
 *  Source mode counts — it's still an editable note — while read-only and
 *  presentation don't, and neither does a plain-text file's editor: a markdown
 *  image embed means nothing in a .py. */
function editorAtDrop(el: Element | null): EditorView | null {
  const view = getActiveView();
  if (!el || !view || view.state.readOnly || !view.dom.contains(el)) return null;
  const s = useAppStore.getState();
  if (s.presentationActive || s.mdViewMode === "readonly") return null;
  const path = s.activeFilePath;
  if (!path || !(isMarkdownFile(path) || isDraftPath(path))) return null;
  return view;
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
  const runPanelOpen = useAppStore((s) => s.runPanelOpen);
  const runPanelWidth = useAppStore((s) => s.runPanelWidth);
  const setRunPanelWidth = useAppStore((s) => s.setRunPanelWidth);
  const docKey = useAppStore((s) => s.docKey);
  const presentationActive = useAppStore((s) => s.presentationActive);
  const presentationScale = useAppStore((s) => s.presentationScale);
  const presentationMode = useAppStore((s) => s.presentationMode);
  const slidesActive = presentationActive && presentationMode === "slides";
  const editorFontSize = useAppStore((s) => s.editorFontSize);

  // The terminal panel stays mounted once opened so toggling it just hides the
  // panel (shells keep running); it's torn down only when its last tab closes.
  const [bottomPanelMounted, setBottomPanelMounted] = useState(false);
  useEffect(() => {
    if (bottomPanelOpen) setBottomPanelMounted(true);
  }, [bottomPanelOpen]);
  const save = useAppStore((s) => s.save);
  const restoreWorkspace = useAppStore((s) => s.restoreWorkspace);

  // Locking is driven from here even when the settings window asked for it:
  // any plaintext the user typed into an unlocked block lives in this window's
  // editor, and lockNow encrypts it back into the document before the keys are
  // dropped. Locking anywhere else would throw that writing away.
  useEffect(() => {
    const un = listen<{ workspace?: string }>(VAULT_LOCK_REQUEST, ({ payload }) => {
      const workspace = useAppStore.getState().workspacePath;
      if (!workspace || (payload.workspace && payload.workspace !== workspace))
        return;
      void lockNow(getActiveView() ?? undefined);
    });
    return () => {
      un.then((fn) => fn());
    };
  }, []);

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

  // Presentation is tied to the file that was active at entry. An external
  // "Open With" event (or any other programmatic switch) ends it instead of
  // silently presenting a different file.
  const presentedPathRef = useRef<string | null>(null);
  useEffect(() => {
    if (!presentationActive) {
      presentedPathRef.current = null;
      return;
    }
    if (presentedPathRef.current === null) {
      presentedPathRef.current = activeFilePath;
      if (!activeFilePath) useAppStore.getState().exitPresentation();
      return;
    }
    if (activeFilePath !== presentedPathRef.current)
      useAppStore.getState().exitPresentation();
  }, [activeFilePath, presentationActive]);

  // Enter native fullscreen where available, but keep the in-window immersive
  // layout as a fallback (plain-browser development and denied native calls).
  // Only undo fullscreen on exit when presentation itself turned it on.
  useEffect(() => {
    if (!presentationActive) return;
    let win: ReturnType<typeof getCurrentWindow>;
    try {
      win = getCurrentWindow();
    } catch {
      useAppStore
        .getState()
        .showToast("无法进入系统全屏，已使用窗口内演示", "error");
      return;
    }

    let disposed = false;
    let ownsFullscreen = false;
    let expectFullscreen = false;
    let unlistenResize: (() => void) | undefined;
    let enterFullscreen: Promise<void> | null = null;

    void (async () => {
      try {
        const alreadyFullscreen = await win.isFullscreen();
        if (disposed) return;
        ownsFullscreen = !alreadyFullscreen;
        if (!alreadyFullscreen) {
          enterFullscreen = win.setFullscreen(true);
          await enterFullscreen;
        }
        if (disposed) return;
        expectFullscreen = true;
      } catch {
        ownsFullscreen = false;
        if (!disposed)
          useAppStore
            .getState()
            .showToast("无法进入系统全屏，已使用窗口内演示", "error");
        return;
      }

      try {
        unlistenResize = await win.onResized(() => {
          if (disposed || !expectFullscreen) return;
          void win
            .isFullscreen()
            .then((fullscreen) => {
              if (!disposed && !fullscreen)
                useAppStore.getState().exitPresentation();
            })
            .catch(() => {});
        });
      } catch {
        // Fullscreen still works; only native-exit detection is unavailable.
      }
    })();

    return () => {
      disposed = true;
      expectFullscreen = false;
      unlistenResize?.();
      if (ownsFullscreen)
        void (async () => {
          try {
            await enterFullscreen;
          } catch {
            return;
          }
          await win.setFullscreen(false).catch(() => {});
        })();
    };
  }, [presentationActive]);

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
  const [viewportWidth, setViewportWidth] = useState(window.innerWidth);
  const narrow = viewportWidth < 768;
  const [isDragging, setIsDragging] = useState(false);
  const dragging = useRef(false);

  // F5 enters presentation from anywhere in the editor. While presenting, a
  // capture-phase handler owns Escape/zoom/page navigation so CodeMirror or an
  // open search panel cannot consume those keys first.
  useEffect(() => {
    const onPresentationKey = (e: KeyboardEvent) => {
      const state = useAppStore.getState();
      if (!state.presentationActive) {
        if (e.key !== "F5") return;
        const modalOpen =
          !!state.prompt ||
          !!state.confirm ||
          !!state.gitCredentialPrompt ||
          !!state.history;
        if (modalOpen) return;
        e.preventDefault();
        state.enterPresentation();
        return;
      }

      const stop = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (e.key === "Escape" || e.key === "F5") {
        stop();
        state.exitPresentation();
        return;
      }
      if (e.metaKey || e.ctrlKey) {
        if (e.key === "+" || e.key === "=") {
          stop();
          state.setPresentationScale(
            state.presentationScale + PRESENTATION_SCALE_STEP,
          );
          return;
        }
        if (e.key === "-" || e.key === "_") {
          stop();
          state.setPresentationScale(
            state.presentationScale - PRESENTATION_SCALE_STEP,
          );
          return;
        }
        if (e.key === "0") {
          stop();
          state.setPresentationScale(PRESENTATION_SCALE_DEFAULT);
          return;
        }
        // Editing/search/global-new shortcuts must not mutate or replace the
        // file hidden behind the read-only presentation surface.
        if (["n", "s", "f"].includes(e.key.toLowerCase())) {
          stop();
          return;
        }
      }

      // Parameter fields keep navigation keys (slider steps, select options,
      // text cursor movement) instead of turning the presentation page.
      const inField = (e.target as HTMLElement | null)?.closest("input, select, textarea, [contenteditable=true], [role=slider], [role=spinbutton]");
      if (inField) return;

      if (state.presentationMode === "slides" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        // Space on a focused control activates that control instead of also
        // advancing the slide. Elsewhere it behaves like a presentation remote.
        const onControl = (e.target as HTMLElement | null)?.closest("button, input, select, textarea, a");
        if (["ArrowRight", "ArrowDown", "PageDown", "ArrowLeft", "ArrowUp", "PageUp", "Home", "End"].includes(e.key) || (e.key === " " && !onControl)) {
          stop();
          const previous = ["ArrowLeft", "ArrowUp", "PageUp"].includes(e.key) || (e.key === " " && e.shiftKey);
          state.setPresentationPage(e.key === "Home" ? 0 : e.key === "End" ? state.presentationPageCount - 1 : state.presentationPage + (previous ? -1 : 1));
          return;
        }
      }

      if (state.presentationMode !== "slides" && ["PageUp", "PageDown", "Home", "End"].includes(e.key)) {
        const scroller =
          getActiveView()?.scrollDOM ??
          document.querySelector<HTMLElement>("[data-presentation-scroll]");
        if (!scroller) return;
        stop();
        if (e.key === "Home") scroller.scrollTo({ top: 0, behavior: "smooth" });
        else if (e.key === "End")
          scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
        else
          scroller.scrollBy({
            top: (e.key === "PageDown" ? 1 : -1) * scroller.clientHeight * 0.85,
            behavior: "smooth",
          });
      }
    };
    window.addEventListener("keydown", onPresentationKey, true);
    return () => window.removeEventListener("keydown", onPresentationKey, true);
  }, []);

  // Global Ctrl/Cmd+N creates an untitled draft and Ctrl/Cmd+S saves;
  // Configurable find/replace shortcuts work even when focus is elsewhere
  // — except other text inputs (chat, terminal), which keep their own keys.
  // Ctrl/Cmd+Shift+F opens the sidebar global search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const state = useAppStore.getState();
      if (e.defaultPrevented || e.isComposing || state.presentationActive) return;
      const view = getActiveView();
      const target = e.target as HTMLElement | null;
      const inOtherInput =
        !!target && !view?.dom.contains(target) &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      const modalOpen = !!state.prompt || !!state.confirm || !!state.gitCredentialPrompt || !!state.history;
      // Reuse CodeMirror's active bindings and key normalization instead of
      // keeping a second fixed shortcut list in the app-level handler.
      if (view && !inOtherInput && !modalOpen && runScopeHandlers(view, e, "search-open")) {
        e.preventDefault();
        return;
      }
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.altKey &&
        !e.shiftKey &&
        e.key.toLowerCase() === "n"
      ) {
        e.preventDefault();
        if (!inOtherInput && !modalOpen) void state.newDraft();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        save();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        useAppStore.getState().openGlobalSearch();
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  // Files dragged in from the OS (Finder/Explorer). Tauri delivers native
  // drag-drop as webview events carrying bare paths and a window coordinate,
  // not HTML5 DataTransfer, so this is window-wide and does its own hit test.
  // Where the file lands decides what the drop means:
  //   • on the markdown editor → it's referenced at the drop point, the file
  //     copied into the dir set in 设置 › 图片/附件 (same as pasting one)
  //   • on the sidebar tree → copy into the folder under the pointer
  //   • anywhere else → it opens, as a drop always used to
  // Outside the sidebar, a dropped .md opens instead of becoming an attachment.
  const [dropHint, setDropHint] = useState<"open" | "insert" | null>(null);
  // Only "enter" and "drop" carry paths, so they're kept here for the "over"
  // events in between — the hint has to know whether it's markdown being
  // dragged to say what releasing will do.
  const dragPaths = useRef<string[]>([]);
  useEffect(() => {
    let cursorView: EditorView | null = null;
    const sidebarFeedback = createSidebarDropFeedback();
    const clearCursor = () => {
      if (cursorView) setFileDropCursor(cursorView, null);
      cursorView = null;
    };
    const hintAt = (position: PhysicalPosition) => {
      const el = elementAtDrop(position);
      const target = sidebarDropTarget(el);
      if (target && dragPaths.current.length) {
        clearCursor();
        sidebarFeedback.show(target, dropPoint(position), dragPaths.current.length);
        return null;
      }
      sidebarFeedback.clear();
      const view = editorAtDrop(el);
      const insert = view && dragPaths.current.some((path) => !isMarkdownFile(path));
      if (cursorView !== view || !insert) clearCursor();
      if (insert) {
        cursorView = view;
        setFileDropCursor(view, dropPoint(position));
      }
      if (el?.closest("[data-sidebar]")) return null;
      return insert ? ("insert" as const) : ("open" as const);
    };

    const unlisten = getCurrentWebview().onDragDropEvent(async (event) => {
      if (event.payload.type === "enter") {
        dragPaths.current = event.payload.paths;
        setDropHint(hintAt(event.payload.position));
      } else if (event.payload.type === "over") {
        setDropHint(hintAt(event.payload.position));
      } else if (event.payload.type === "leave") {
        clearCursor();
        sidebarFeedback.clear();
        dragPaths.current = [];
        setDropHint(null);
      } else if (event.payload.type === "drop") {
        clearCursor();
        sidebarFeedback.clear();
        setDropHint(null);
        dragPaths.current = [];
        const { paths, position } = event.payload;
        if (paths.length === 0) return;

        // Resolve the target before any await: the pointer is gone by then.
        const el = elementAtDrop(position);
        const target = sidebarDropTarget(el);
        if (target) {
          const copyWorkspace = useAppStore.getState().workspacePath;
          void getCurrentWindow().setFocus().catch(() => {});
          let copied = 0;
          const failures: string[] = [];
          for (const path of paths) {
            try {
              if (await pathIsDir(path)) throw new Error("请拖入文件，暂不支持拷贝文件夹");
              await saveFileToDir(path, target.dir, basename(path));
              copied += 1;
            } catch (error) {
              failures.push(`「${basename(path)}」：${error}`);
            }
          }
          const store = useAppStore.getState();
          // Refresh even after a partial failure so completed copies are visible.
          if (copied && store.workspacePath === copyWorkspace) {
            store.setExpanded(target.dir, true);
            try {
              await store.refreshTree();
            } catch (error) {
              failures.push(`目录刷新失败：${error}`);
            }
          }
          store.showToast(
            failures.length
              ? `已拷贝 ${copied} 个文件；${failures.join("；")}`
              : `已拷贝 ${copied} 个文件到「${basename(target.dir)}」`,
            failures.length ? "error" : "success",
          );
          return;
        }
        if (el?.closest("[data-sidebar]")) return;
        const view = editorAtDrop(el);
        // Resolved now, not after the awaits below: it's where the pointer was
        // when the file landed, and the view could be gone by then.
        const at = view?.posAtCoords(dropPoint(position));

        // A drop is a hand-off from another app, so the drag itself is the
        // request to come forward: without this the note opens (or grows a
        // reference) behind whatever window the file was dragged out of, and
        // the editor can't take the caret that insertRefs hands it.
        void getCurrentWindow().setFocus().catch(() => {});

        // A folder can be neither opened as a note nor referenced as a file.
        const files: string[] = [];
        for (const p of paths) if (!(await pathIsDir(p))) files.push(p);
        if (files.length === 0) {
          window.alert(`「${basename(paths[0])}」是文件夹，请拖入文件。`);
          return;
        }

        if (!view || files.every(isMarkdownFile)) {
          await useAppStore.getState().openFile(files[0]);
          return;
        }
        await handleEditorDrop(view, files, at);
      }
    });
    return () => {
      clearCursor();
      sidebarFeedback.clear();
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
    const onResize = () => setViewportWidth(window.innerWidth);
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

  // When both independent right-side panels are open, preserve a usable editor
  // instead of letting their saved widths squeeze it to zero. At the minimum
  // window size the sidebar is an overlay, leaving room for both 220px panels.
  useEffect(() => {
    if (!runPanelOpen || !rightPanelOpen) return;
    const available = Math.max(
      RIGHT_PANEL_MIN_W * 2,
      viewportWidth - leftWidth - EDITOR_MIN_W,
    );
    const total = runPanelWidth + rightPanelWidth;
    if (total <= available) return;
    let nextRun = Math.max(
      RIGHT_PANEL_MIN_W,
      Math.round((available * runPanelWidth) / total),
    );
    let nextRight = available - nextRun;
    if (nextRight < RIGHT_PANEL_MIN_W) {
      nextRight = RIGHT_PANEL_MIN_W;
      nextRun = available - nextRight;
    }
    setRunPanelWidth(nextRun);
    setRightPanelWidth(nextRight);
  }, [
    leftWidth,
    rightPanelOpen,
    rightPanelWidth,
    runPanelOpen,
    runPanelWidth,
    setRightPanelWidth,
    setRunPanelWidth,
    viewportWidth,
  ]);

  const startRightPanelResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const state = useAppStore.getState();
      const startW = state.rightPanelWidth;
      const reservedRunWidth = state.runPanelOpen ? state.runPanelWidth : 0;
      const maxW = Math.max(
        RIGHT_PANEL_MIN_W,
        window.innerWidth - leftWidth - reservedRunWidth - EDITOR_MIN_W,
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

  const startRunPanelResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const state = useAppStore.getState();
      const startW = state.runPanelWidth;
      const reservedAiWidth = state.rightPanelOpen ? state.rightPanelWidth : 0;
      const maxW = Math.max(
        RIGHT_PANEL_MIN_W,
        window.innerWidth - leftWidth - reservedAiWidth - EDITOR_MIN_W,
      );
      const onMove = (ev: MouseEvent) => {
        setRunPanelWidth(
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
    [leftWidth, setRunPanelWidth],
  );

  return (
    <div
      className={`flex h-screen w-screen flex-col overflow-hidden ${
        presentationActive ? `presentation-active${slidesActive ? " presentation-slides" : ""}` : ""
      }`}
      style={
        presentationActive
          ? ({
              "--editor-font-size": `${editorFontSize * presentationScale}px`,
            } as CSSProperties)
          : undefined
      }
    >
      {/* Custom draggable title bar (native title is hidden). */}
      {!presentationActive && <TitleBar leftWidth={leftWidth} />}
      <AppToast />

      <div className="relative flex min-h-0 flex-1">
      {/* Sidebar. Desktop: width collapses to 0 so the editor reclaims the
          space; the inner wrapper keeps a fixed width so content doesn't reflow
          mid-animation. Narrow: slides in/out as an overlay drawer. */}
      {!presentationActive && (
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
          data-sidebar
        >
          <div style={{ width }} className="h-full">
            <Sidebar />
          </div>
        </div>
      )}

      {/* Resize handle (desktop only): an invisible grab zone floated on the
          seam as an overlay, so the two panes stay flush — their bottom borders
          meet as one continuous line and the bg-color seam runs top to bottom. */}
      {!presentationActive && !narrow && sidebarOpen && (
        <div
          onMouseDown={onMouseDown}
          className="absolute bottom-0 top-0 z-20 w-[6px] -translate-x-1/2 cursor-col-resize"
          style={{ left: leftWidth }}
          title="拖拽调整宽度"
        />
      )}

      {/* Backdrop for mobile drawer */}
      {!presentationActive && narrow && sidebarOpen && (
        <div
          className="absolute inset-0 z-30 bg-black/30"
          onClick={toggleSidebar}
        />
      )}

      {/* Main editor pane */}
      <div className="relative flex min-w-0 flex-1 flex-col" style={{ background: "var(--bg)" }}>
        {!presentationActive && dropHint && (
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
              {dropHint === "insert" ? "松开以插入引用" : "松开以打开文件"}
            </span>
          </div>
        )}
        <div data-editor-pane className="relative flex min-h-0 flex-1 flex-col">
        {!presentationActive && <EditorTabs />}
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
            {!presentationActive &&
              (isMarkdownFile(activeFilePath) || isDraftPath(activeFilePath)) && (
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
            <div className="relative min-h-0 flex-1 overflow-hidden">
              {/* Both presentation modes display this same mounted editor. */}
              <div className="presentation-editor h-full">
                {isImageFile(activeFilePath) ? (
                  <ImageView
                    path={activeFilePath}
                    presentationScale={
                      presentationActive ? presentationScale : undefined
                    }
                  />
                ) : (
                  // key forces a clean remount when switching files
                  <ErrorBoundary resetKey={docKey}>
                    <CodeMirrorEditor key={docKey} />
                  </ErrorBoundary>
                )}
              </div>
              {slidesActive && <SlidePresentation />}
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
            visible={bottomPanelOpen && !presentationActive}
            onAllClosed={() => {
              setBottomPanelMounted(false);
              if (bottomPanelOpen) toggleBottomPanel();
            }}
          />
        )}
      </div>
      {!presentationActive && runPanelOpen && (
        <div className="relative h-full shrink-0" style={{ width: runPanelWidth }}>
          <div
            onMouseDown={startRunPanelResize}
            className="absolute bottom-0 left-0 top-0 z-30 w-[7px] -translate-x-1/2 cursor-col-resize"
            title="拖动调整运行输出宽度"
          />
          <RunPanel />
        </div>
      )}
      {!presentationActive && rightPanelOpen && (
        <div className="relative h-full shrink-0" style={{ width: rightPanelWidth }}>
          <div
            onMouseDown={startRightPanelResize}
            className="absolute bottom-0 left-0 top-0 z-30 w-[7px] -translate-x-1/2 cursor-col-resize"
            title="拖动调整笔记助手宽度"
          />
          <RightPanel />
        </div>
      )}
      </div>

      {presentationActive && <PresentationControls />}

      <PromptModal />
      <ConfirmModal />
      <VaultModal />
      <HistoryModal />
    </div>
  );
}

export default App;
