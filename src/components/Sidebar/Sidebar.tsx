import { tr } from "../../i18n/core.ts";
import { useLanguage } from "../../i18n/react";
import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import {
  AppWindow,
  FolderOpen,
  FolderX,
  Folders,
  Folder,
  NotebookText,
  TableOfContents,
  RefreshCw,
  Search,
  Share2,
  FilePlus2,
  FolderPlus,
  ChevronsDownUp,
  Ellipsis,
  ChevronsUpDown,
  Crosshair,
  X,
  Settings,
  Printer,
  Download,
  FileDown,
  ChevronDown,
} from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { getVersion } from "@tauri-apps/api/app";
import { SubMenuItem } from "../ContextSubMenu";
import { useAppStore, type SidebarMode } from "../../store/useAppStore";
import {
  basename,
  dirname,
  fileStat,
  findNode,
  isImageFile,
  isMarkdownFile,
  showFileInfo,
  type FileNode,
} from "../../lib/fs";
import {
  copyText,
  copyFilesToClipboard,
  listPasteConflicts,
  pasteFromClipboard,
  relativePath,
} from "../../lib/clipboard";
import {
  exportCurrentNoteAsPdf,
  printCurrentNote,
} from "../../lib/print/printNote";
import { ShareDialog } from "../ShareDialog";
import { FileTree } from "./FileTree";
import { NotesTree } from "./NotesTree";
import { OutlinePanel } from "./OutlinePanel";
import { SearchPanel } from "./SearchPanel";
import { ZoomScrollbar, scrollbarReservesGutter } from "./ZoomScrollbar";
import { isMac } from "../../lib/platform";
import { relativePathWithinWorkspace } from "../../lib/workspacePath";
import { getRepoRoot, ignoreUntracked } from "../../lib/git";

type BrowseSidebarMode = Exclude<SidebarMode, "search">;

const MODES: { id: BrowseSidebarMode; title: string; icon: React.ReactNode }[] = [
  { id: "files", get title() { return tr("文件模式"); }, icon: <Folder size={14} /> },
  { id: "notes", get title() { return tr("笔记模式"); }, icon: <NotebookText size={14} /> },
  { id: "outline", get title() { return tr("预览大纲"); }, icon: <TableOfContents size={14} /> },
];

interface MenuState {
  x: number;
  y: number;
  /** The right-clicked node, or null for the blank area (workspace root). */
  node: FileNode | null;
  /** Path used by the selectable row. This differs from `node.path` for a
   *  visually folded folder chain in notes mode. */
  selectionPath: string | null;
}

const MENU_EDGE_PADDING = 8;
// The context menu sizes to its longest label (English runs wider); clamp
// against its widest allowed size (max-w-56) so it always stays on screen.
const SIDEBAR_MENU_WIDTH = 224;
const MENU_ROW_HEIGHT = 32;
const MENU_VERTICAL_PADDING = 8;

function estimateContextMenuHeight(
  node: FileNode | null,
  workspacePath: string | null,
  gitRepo: boolean,
): number {
  const rows = node
    ? 4 + // 新建笔记 / 文件 / 文件夹 / .gitignore (alongside, for a file)
      (gitRepo && workspacePath ? 1 : 0) + // 添加到 .gitignore
      1 + // 复制 submenu
      1 + // 粘贴
      1 + // 打开所在目录
      1 + // 显示简介
      (gitRepo && (node.is_dir || !isImageFile(node.path)) ? 1 : 0) +
      1 + // 重命名
      1 + // 删除
      (node.is_dir || isMarkdownFile(node.path) ? 1 : 0) // 分享文件夹 / 分享笔记
    : 4 +
      1 + // 粘贴
      1 + // 打开所在目录
      1 + // 显示简介
      (gitRepo && workspacePath ? 1 : 0) +
      2; // 刷新 / 分享文件夹
  return rows * MENU_ROW_HEIGHT + MENU_VERTICAL_PADDING;
}

function clampMenuPosition(x: number, y: number, estimatedHeight: number) {
  return {
    left: Math.max(
      MENU_EDGE_PADDING,
      Math.min(x, window.innerWidth - SIDEBAR_MENU_WIDTH - MENU_EDGE_PADDING),
    ),
    top: Math.max(
      MENU_EDGE_PADDING,
      Math.min(y, window.innerHeight - estimatedHeight - MENU_EDGE_PADDING),
    ),
  };
}

export function Sidebar() {
  useLanguage();
  const workspacePath = useAppStore((s) => s.workspacePath);
  const tree = useAppStore((s) => s.tree);
  const loadingWorkspace = useAppStore((s) => s.loadingWorkspace);
  const notesTree = useAppStore((s) => s.notesTree);
  const notesLoading = useAppStore((s) => s.notesLoading);
  const notesError = useAppStore((s) => s.notesError);
  const loadNotes = useAppStore((s) => s.loadNotes);
  const openWorkspace = useAppStore((s) => s.openWorkspace);
  const requestOpenWorkspace = useAppStore((s) => s.requestOpenWorkspace);
  const requestOpenWorkspaceAt = useAppStore((s) => s.requestOpenWorkspaceAt);
  const closeWorkspace = useAppStore((s) => s.closeWorkspace);
  const closeAllWorkspaces = useAppStore((s) => s.closeAllWorkspaces);
  const recentWorkspaces = useAppStore((s) => s.recentWorkspaces);
  const sidebarMode = useAppStore((s) => s.sidebarMode);
  const setSidebarMode = useAppStore((s) => s.setSidebarMode);
  const openGlobalSearch = useAppStore((s) => s.openGlobalSearch);
  const refreshTree = useAppStore((s) => s.refreshTree);
  const selectedPath = useAppStore((s) => s.selectedPath);
  const selectedPaths = useAppStore((s) => s.selectedPaths);
  const setSelection = useAppStore((s) => s.setSelection);
  const clearSelection = useAppStore((s) => s.clearSelection);
  const requestNewFile = useAppStore((s) => s.requestNewFile);
  const requestNewRawFile = useAppStore((s) => s.requestNewRawFile);
  const newRawFile = useAppStore((s) => s.newRawFile);
  const openFile = useAppStore((s) => s.openFile);
  const showToast = useAppStore((s) => s.showToast);
  const requestNewFolder = useAppStore((s) => s.requestNewFolder);
  const expandAllFolders = useAppStore((s) => s.expandAllFolders);
  const collapseAllFolders = useAppStore((s) => s.collapseAllFolders);
  const revealInTree = useAppStore((s) => s.revealInTree);
  const activeFilePath = useAppStore((s) => s.activeFilePath);
  const requestRename = useAppStore((s) => s.requestRename);
  const removeMany = useAppStore((s) => s.removeMany);
  const openConfirm = useAppStore((s) => s.openConfirm);
  const openSettings = useAppStore((s) => s.openSettings);
  const openNewWindow = useAppStore((s) => s.openNewWindow);
  const compactSidebar = useAppStore((s) => s.compactSidebar);
  const uiZoom = useAppStore((s) => s.uiZoom);
  const gitInfo = useAppStore((s) => s.gitInfo);
  const openHistoryAt = useAppStore((s) => s.openHistoryAt);

  const [menu, setMenu] = useState<MenuState | null>(null);
  const [sharingFolder,setSharingFolder]=useState<string|null>(null);
  const [sharingNote,setSharingNote]=useState(false);
  const [wsMenuOpen, setWsMenuOpen] = useState(false);
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const lastBrowseMode = useRef<BrowseSidebarMode>("files");

  // Spin the refresh icon while the tree reloads. listDir is usually instant, so
  // hold the spinner for a short minimum (one full rotation) — otherwise the
  // click gives no visible feedback that a refresh actually happened.
  const handleRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    const started = Date.now();
    try {
      await refreshTree();
    } finally {
      const MIN_SPIN = 600;
      const elapsed = Date.now() - started;
      if (elapsed < MIN_SPIN)
        await new Promise((r) => setTimeout(r, MIN_SPIN - elapsed));
      setRefreshing(false);
    }
  };
  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => {});
  }, []);
  useEffect(() => {
    if (sidebarMode !== "search") lastBrowseMode.current = sidebarMode;
  }, [sidebarMode]);
  const recents = recentWorkspaces.filter((p) => p !== workspacePath);
  // Const alias so TypeScript keeps the null-narrowing inside menu callbacks.
  const menuNode = menu?.node ?? null;
  // A context menu opened on a member of the multi-selection acts on the whole
  // selection. Opening it elsewhere first collapses back to that one row.
  const menuBelongsToSelection = !!(
    menuNode &&
    selectedPaths.length > 1 &&
    (selectedPaths.includes(menuNode.path) ||
      (!!menu?.selectionPath && selectedPaths.includes(menu.selectionPath)))
  );
  const menuPaths = menuNode
    ? menuBelongsToSelection
      ? selectedPaths
      : [menuNode.path]
    : [];
  const menuHasMultiple = menuPaths.length > 1;
  const searchActive = sidebarMode === "search";
  const menuPos = menu
    ? clampMenuPosition(
        menu.x,
        menu.y,
        estimateContextMenuHeight(menuNode, workspacePath, !!gitInfo?.isRepo),
      )
    : null;

  // Auto-hiding scrollbar: reveal the thumb on scroll, hide it after a pause.
  const listRef = useRef<HTMLDivElement>(null);
  const scrollTimer = useRef<number | undefined>(undefined);
  const onListScroll = () => {
    const el = listRef.current;
    if (!el) return;
    el.classList.add("is-scrolling");
    window.clearTimeout(scrollTimer.current);
    scrollTimer.current = window.setTimeout(
      () => el.classList.remove("is-scrolling"),
      800,
    );
  };
  useEffect(() => () => window.clearTimeout(scrollTimer.current), []);

  // macOS 12's WKWebView rasterises accelerated `overflow:auto` scrolling
  // layers at their unzoomed scale and bitmap-stretches them under native page
  // zoom, so the file list turns blurry at any zoom != 100% (the editor and AI
  // panel don't scroll through such a layer, so they stay crisp). While zoomed
  // we switch the list to `overflow:hidden` — which keeps it out of a composited
  // layer, so subpixel text re-rasterises crisply. That box scrolls only when
  // `scrollTop` is assigned and shows no scrollbar of its own, so `ZoomScrollbar`
  // takes over both jobs. It needs the same gutter the native scrollbar took —
  // none at all where scrollbars are overlays — so that zooming doesn't reflow
  // the rows.
  const needsManualZoomScroll = isMac && Math.abs(uiZoom - 1) > 0.001;
  const zoomScrollClasses = needsManualZoomScroll
    ? `overflow-hidden${scrollbarReservesGutter() ? " pr-[9px]" : ""}`
    : "overflow-y-auto";

  useEffect(() => {
    const close = (event: Event) => {
      const target = event.target;
      if (
        event.type === "scroll" &&
        target instanceof Element &&
        target.closest("[data-menu-panel='true']")
      ) {
        return;
      }
      setMenu(null);
      setWsMenuOpen(false);
      setNewMenuOpen(false);
      setMoreMenuOpen(false);
    };
    // A press on a window drag region (blank title bar) never becomes a click:
    // Tauri starts a native drag instead, so close on that press directly.
    const closeOnDrag = (event: MouseEvent) => {
      const attr = (event.target as Element | null)?.getAttribute?.("data-tauri-drag-region");
      if (attr != null && attr !== "false") close(event);
    };
    if (menu || wsMenuOpen || newMenuOpen || moreMenuOpen) {
      window.addEventListener("click", close);
      window.addEventListener("mousedown", closeOnDrag, true);
      window.addEventListener("scroll", close, true);
      return () => {
        window.removeEventListener("click", close);
        window.removeEventListener("mousedown", closeOnDrag, true);
        window.removeEventListener("scroll", close, true);
      };
    }
  }, [menu, wsMenuOpen, newMenuOpen, moreMenuOpen]);

  const openContextMenu = (e: React.MouseEvent, node: FileNode) => {
    e.preventDefault();
    e.stopPropagation();
    const selectionPath =
      (e.currentTarget as HTMLElement).dataset.treePath ?? node.path;
    const belongsToSelection =
      selectedPaths.includes(node.path) || selectedPaths.includes(selectionPath);
    if (selectedPaths.length > 1 && !belongsToSelection) {
      setSelection([], selectionPath);
    }
    setMenu({ x: e.clientX, y: e.clientY, node, selectionPath });
  };

  // Blank area of the list = the workspace root (rows stopPropagation).
  const openRootContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    // File operations don't apply to the search results list.
    if (!workspacePath || sidebarMode === "search") return;
    setMenu({ x: e.clientX, y: e.clientY, node: null, selectionPath: null });
  };

  const copyNodesToClipboard = (paths: string[]) => {
    copyFilesToClipboard(paths).catch((err) => {
      window.alert(tr("复制失败：{{0}}", { 0: err }));
    });
  };

  const createGitignore = async (dir: string | null) => {
    if (!dir) return;
    try {
      const path = `${dir}/.gitignore`;
      if (await fileStat(path)) await openFile(path);
      else await newRawFile(dir, ".gitignore");
    } catch (error) {
      showToast(tr("创建 .gitignore 失败：{{0}}", {
        0: error instanceof Error ? error.message : String(error),
      }), "error");
    }
  };

  const addToGitignore = async (paths: string[]) => {
    if (!workspacePath || !paths.length) return;
    try {
      const root = await getRepoRoot(workspacePath);
      const relativePaths = paths.map((path) => {
        const relative = relativePathWithinWorkspace(root, path);
        if (!relative) throw new Error(tr("路径不在当前工作区内。"));
        return relative;
      });
      // Save an open .gitignore before appending, then refresh its editor buffer.
      await useAppStore.getState().flushActiveTab();
      await ignoreUntracked(root, relativePaths);
      if (useAppStore.getState().workspacePath !== workspacePath) return;
      await refreshTree();
      const active = useAppStore.getState().activeFilePath;
      if (active && relativePathWithinWorkspace(root, active) === ".gitignore") {
        await openFile(active);
      }
      showToast(tr("已添加到 .gitignore"), "success");
    } catch (error) {
      showToast(tr("添加到 .gitignore 失败：{{0}}", {
        0: error instanceof Error ? error.message : String(error),
      }), "error");
    }
  };

  const pasteInto = async (dir: string) => {
    const paste = async (overwrite: boolean) => {
      await pasteFromClipboard(dir, overwrite);
      await refreshTree();
    };
    try {
      const conflicts = await listPasteConflicts(dir);
      if (!conflicts.length) {
        await paste(false);
        return;
      }
      // Same-name entries: let the user choose instead of silently making a
      // " 2" copy. Errors thrown by either action surface inside the dialog.
      const listed = conflicts.slice(0, 3).map((name) => `「${name}」`).join("、");
      openConfirm({
        title: tr("存在同名项目"),
        message:
          conflicts.length === 1
            ? tr("目标文件夹中已有 {{0}}。覆盖会替换现有项目（文件夹整体替换），保留两份则以「{{1}} 2」这样的名称粘贴。", { 0: listed, 1: conflicts[0] })
            : tr("目标文件夹中已有 {{0}} 个同名项目（{{1}}{{2}}）。覆盖会替换现有项目（文件夹整体替换），保留两份则以「名称 2」这样的名称粘贴。", { 0: conflicts.length, 1: listed, 2: conflicts.length > 3 ? tr(" 等") : "" }),
        confirmLabel: tr("覆盖"),
        onConfirm: () => paste(true),
        altLabel: tr("保留两份"),
        onAlt: () => paste(false),
      });
    } catch (err) {
      window.alert(tr("粘贴失败：{{0}}", { 0: err }));
    }
  };

  // Drafts and files opened from outside the workspace have no row to find.
  const canLocate =
    !!workspacePath && !!activeFilePath &&
    !!relativePathWithinWorkspace(workspacePath, activeFilePath);

  /** Tree actions used from search results return to the tree search was
   *  opened from (files unless that was notes). */
  const showTree = () => {
    if (sidebarMode !== "files" && sidebarMode !== "notes")
      setSidebarMode(lastBrowseMode.current === "notes" ? "notes" : "files");
  };

  const locateActiveFile = async () => {
    if (!activeFilePath) return;
    showTree();
    if (!(await revealInTree(activeFilePath))) return;
    // The ancestors render on the next commit; scroll once their rows exist.
    requestAnimationFrame(() => {
      listRef.current
        ?.querySelector<HTMLElement>(`[data-tree-path="${CSS.escape(activeFilePath)}"]`)
        ?.scrollIntoView({ block: "center" });
    });
  };

  /** Paste destination: the selected folder, a selected file's parent, or root. */
  const pasteTarget = (): string | null => {
    if (!workspacePath) return null;
    if (!selectedPath) return workspacePath;
    const node = findNode(tree, selectedPath) ?? findNode(notesTree, selectedPath);
    if (node?.is_dir) return node.path;
    return dirname(selectedPath);
  };

  // File-list shortcuts (the list container takes focus when clicked).
  const onListKeyDown = (e: React.KeyboardEvent) => {
    const selection = selectedPaths.length
      ? selectedPaths
      : selectedPath
        ? [selectedPath]
        : [];
    // Both keys are accepted because the forward-delete key is reported as
    // "Delete", while the main delete key on a Mac is reported as "Backspace".
    if (
      (sidebarMode === "files" || sidebarMode === "notes") &&
      (e.key === "Delete" || e.key === "Backspace") &&
      selection.length &&
      !e.repeat
    ) {
      e.preventDefault();
      void removeMany(selection);
      return;
    }
    if (!(e.metaKey || e.ctrlKey)) return;
    const key = e.key.toLowerCase();
    if (key === "c" && selection.length) {
      e.preventDefault();
      copyNodesToClipboard(selection);
    } else if (key === "v") {
      const dir = pasteTarget();
      if (dir) {
        e.preventDefault();
        void pasteInto(dir);
      }
    }
  };

  const toggleSearchMode = () => {
    if (searchActive) {
      setSidebarMode(lastBrowseMode.current);
    } else {
      openGlobalSearch();
    }
  };

  return (
    <div
      className="sidebar-pane flex h-full flex-col"
      style={{
        background: "var(--sidebar-bg)",
        borderRight: "1px solid var(--border)",
      }}
    >
      {/* Workspace header */}
      <div
        className="relative flex flex-col gap-1 px-2 py-1.5"
        style={{ borderBottom: "1px solid var(--border)" }}
      >
        <div className="flex items-center justify-between gap-1.5">
          {/* Workspace switcher dropdown */}
          <div className="relative min-w-0 max-w-[calc(100%-4rem)]">
            <button
              onClick={(e) => {
                e.stopPropagation();
                setNewMenuOpen(false);
                setMoreMenuOpen(false);
                setWsMenuOpen((v) => !v);
              }}
              title={workspacePath ?? tr("打开文件夹")}
              className="flex max-w-full items-center gap-1 rounded-md px-1.5 py-1 text-[13px] font-semibold transition-colors"
              style={{ color: "var(--text)" }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--hover)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
              }}
            >
              <span className="truncate">
                {workspacePath ? basename(workspacePath) : tr("未打开工作区")}
              </span>
              <ChevronDown size={13} className="shrink-0" />
            </button>
            {wsMenuOpen && (
              <div
                data-menu-panel="true"
                className="absolute left-0 top-full z-50 mt-1 w-44 rounded-lg py-1 text-sm shadow-lg"
                style={{
                  background: "var(--bg-elev)",
                  border: "1px solid var(--border)",
                  boxShadow: "0 8px 24px var(--shadow)",
                }}
                onClick={(e) => e.stopPropagation()}
              >
                <MenuItem
                  onClick={() => {
                    void openNewWindow();
                    setWsMenuOpen(false);
                  }}
                >
                  <span className="flex items-center gap-2">
                    <AppWindow size={14} /> {" "}{tr("新窗口")}</span>
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    void requestOpenWorkspace();
                    setWsMenuOpen(false);
                  }}
                >
                  <span className="flex items-center gap-2">
                    <FolderOpen size={14} /> {" "}{tr("打开文件夹")}</span>
                </MenuItem>
                {workspacePath && (
                  <MenuItem
                    onClick={() => {
                      void closeWorkspace();
                      setWsMenuOpen(false);
                    }}
                  >
                    <span className="flex items-center gap-2">
                      <FolderX size={14} /> {" "}{tr("关闭当前项目")}</span>
                  </MenuItem>
                )}
                {workspacePath && (
                  <MenuItem
                    onClick={() => {
                      void closeAllWorkspaces();
                      setWsMenuOpen(false);
                    }}
                  >
                    <span className="flex items-center gap-2">
                      <Folders size={14} /> {" "}{tr("关闭所有项目")}</span>
                  </MenuItem>
                )}
                <SubMenuItem label={tr("最近的项目")}>
                  {recents.length ? (
                    recents.map((p) => (
                      <MenuItem
                        key={p}
                        title={p}
                        onClick={() => {
                          requestOpenWorkspaceAt(p);
                          setWsMenuOpen(false);
                        }}
                      >
                        <span className="block truncate">{basename(p)}</span>
                      </MenuItem>
                    ))
                  ) : (
                    <div className="px-3 py-1.5" style={{ color: "var(--text-muted)" }}>
                      {tr("暂无记录")}</div>
                  )}
                </SubMenuItem>
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            {workspacePath && (
              <div className="relative">
                <IconMenuButton
                  title={tr("新建")}
                  open={newMenuOpen}
                  onClick={() => {
                    setWsMenuOpen(false);
                    setMoreMenuOpen(false);
                    setNewMenuOpen((v) => !v);
                  }}
                >
                  <FilePlus2 size={15} />
                </IconMenuButton>
                {newMenuOpen && (
                  <div
                    data-menu-panel="true"
                    className="absolute right-0 top-full z-50 mt-1 w-36 rounded-lg py-1 text-sm shadow-lg"
                    style={{
                      background: "var(--bg-elev)",
                      border: "1px solid var(--border)",
                      boxShadow: "0 8px 24px var(--shadow)",
                    }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <MenuItem
                      onClick={() => {
                        requestNewRawFile(pasteTarget() ?? undefined);
                        setNewMenuOpen(false);
                      }}
                    >
                      <span className="flex items-center gap-2">
                        <FilePlus2 size={14} /> {" "}{tr("新建文件")}</span>
                    </MenuItem>
                    <MenuItem
                      onClick={() => {
                        requestNewFolder(pasteTarget() ?? undefined);
                        setNewMenuOpen(false);
                      }}
                    >
                      <span className="flex items-center gap-2">
                        <FolderPlus size={14} /> {" "}{tr("新建文件夹")}</span>
                    </MenuItem>
                  </div>
                )}
              </div>
            )}
            {workspacePath && (sidebarMode === "files" || sidebarMode === "notes" || searchActive) && (
              <IconButton
                title={tr("定位当前文件")}
                compact
                disabled={!canLocate}
                onClick={() => void locateActiveFile()}
              >
                <Crosshair size={15} />
              </IconButton>
            )}
            <SearchModeButton active={searchActive} onClick={toggleSearchMode} />
            {workspacePath && (
              <IconButton title={tr("刷新文件列表")} compact onClick={handleRefresh}>
                <RefreshCw
                  size={15}
                  className={refreshing ? "animate-spin" : undefined}
                />
              </IconButton>
            )}
            {workspacePath && (sidebarMode === "files" || sidebarMode === "notes" || searchActive) && (
              <div className="relative">
                <IconMenuButton
                  title={tr("更多功能")}
                  open={moreMenuOpen}
                  onClick={() => {
                    setWsMenuOpen(false);
                    setNewMenuOpen(false);
                    setMoreMenuOpen((v) => !v);
                  }}
                >
                  <Ellipsis size={15} />
                </IconMenuButton>
                {moreMenuOpen && (
                  <div
                    data-menu-panel="true"
                    className="absolute right-0 top-full z-50 mt-1 w-36 rounded-lg py-1 text-sm shadow-lg"
                    style={{
                      background: "var(--bg-elev)",
                      border: "1px solid var(--border)",
                      boxShadow: "0 8px 24px var(--shadow)",
                    }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <MenuItem
                      onClick={() => {
                        showTree();
                        void expandAllFolders();
                        setMoreMenuOpen(false);
                      }}
                    >
                      <span className="flex items-center gap-2">
                        <ChevronsUpDown size={14} /> {" "}{tr("全部展开")}</span>
                    </MenuItem>
                    <MenuItem
                      onClick={() => {
                        showTree();
                        collapseAllFolders();
                        setMoreMenuOpen(false);
                      }}
                    >
                      <span className="flex items-center gap-2">
                        <ChevronsDownUp size={14} /> {" "}{tr("全部折叠")}</span>
                    </MenuItem>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Browsing modes stay grouped; global search is a separate action above. */}
        <div
          className="flex w-full shrink-0 items-center overflow-hidden rounded-md"
          style={{ border: "1px solid var(--border)", background: "var(--bg)" }}
        >
          {MODES.map((m, i) => (
            <SegmentButton
              key={m.id}
              title={m.title}
              active={sidebarMode === m.id}
              withDivider={i > 0}
              onClick={() => setSidebarMode(m.id)}
            >
              {m.icon}
            </SegmentButton>
          ))}
        </div>

      </div>

      {/* Tree */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={listRef}
          data-sidebar-drop-root={
            workspacePath && (sidebarMode === "files" || sidebarMode === "notes")
              ? workspacePath
              : undefined
          }
          tabIndex={0}
          data-sidebar-list
          onScroll={onListScroll}
          onContextMenu={openRootContextMenu}
          onKeyDown={onListKeyDown}
          // Clicking empty space (not a row) drops the multi-selection.
          onClick={(e) => {
            if (!(e.target as HTMLElement).closest("[data-tree-path]")) clearSelection();
          }}
          className={`scroll-auto-hide flex-1 outline-none ${zoomScrollClasses} ${
            compactSidebar ? "py-0.5" : "py-1"
          }`}
          style={{
            fontSize:
              sidebarMode === "files" || sidebarMode === "search"
                ? "var(--sidebar-files-font-size)"
                : sidebarMode === "notes"
                  ? "var(--sidebar-notes-font-size)"
                  : "var(--sidebar-outline-font-size)",
            // Rows that don't set a weight of their own inherit this one.
            fontWeight: "var(--sidebar-font-weight)",
          }}
        >
          {loadingWorkspace ? (
            <p role="status" className="flex items-center justify-center gap-2 px-4 py-6 text-xs" style={{ color: "var(--text-muted)" }}>
              <RefreshCw size={14} className="animate-spin shrink-0" />
              {tr("正在打开")}{" "}{basename(loadingWorkspace)}…
            </p>
          ) : workspacePath ? (
            sidebarMode === "search" ? (
              <SearchPanel />
            ) : sidebarMode === "outline" ? (
              <OutlinePanel />
            ) : sidebarMode === "notes" ? (
              notesLoading && !notesTree.length ? (
                <p role="status" className="px-4 py-6 text-center text-xs" style={{ color: "var(--text-muted)" }}>{tr("正在查找笔记…")}</p>
              ) : notesError ? (
                <div role="alert" className="px-4 py-6 text-center text-xs">
                  <p>{notesError}</p>
                  <button className="mt-2 underline" onClick={() => void loadNotes()}>{tr("重试")}</button>
                </div>
              ) : <>
                {notesLoading && <p role="status" className="px-3 py-1 text-xs" style={{ color: "var(--text-muted)" }}>{tr("正在更新笔记…")}</p>}
                <NotesTree nodes={notesTree} onContextMenu={openContextMenu} />
              </>
            ) : tree.length ? (
              <FileTree nodes={tree} onContextMenu={openContextMenu} />
            ) : (
              <p
                className="px-4 py-6 text-center text-xs"
                style={{ color: "var(--text-muted)" }}
              >
                {tr("这个文件夹是空的。")}</p>
            )
          ) : (
            <button
              onClick={openWorkspace}
              className="mx-3 mt-4 flex w-[calc(100%-1.5rem)] items-center justify-center gap-2 rounded-lg py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
              style={{ background: "var(--accent)" }}
            >
              <FolderOpen size={16} /> {" "}{tr("打开文件夹")}</button>
          )}
        </div>
        <ZoomScrollbar targetRef={listRef} enabled={needsManualZoomScroll} />
      </div>

      {/* Footer: app identity + utility buttons */}
      <div
        className={`flex items-center justify-between pl-3 pr-2 ${
          compactSidebar ? "py-1.5" : "py-2"
        }`}
        style={{ borderTop: "1px solid var(--border)" }}
      >
        <span className="flex min-w-0 select-none items-center gap-1.5">
          <span
            className="truncate text-xs font-medium"
            style={{ color: "var(--text-soft)", letterSpacing: "0.02em" }}
          >
            {import.meta.env.DEV ? "Idea Note Dev" : "Idea Note"}
          </span>
          {!import.meta.env.DEV && appVersion && (
            <span
              className="shrink-0 text-[11px]"
              style={{ color: "var(--text-muted)", opacity: 0.75 }}
            >
              {appVersion}
            </span>
          )}
        </span>
        <div className="flex shrink-0 items-center gap-0.5">
          <ExportMenu />
          <IconButton title={tr("设置")} onClick={openSettings}>
            <Settings size={15} />
          </IconButton>
        </div>
      </div>

      {sharingFolder&&createPortal(<ShareDialog folderPath={sharingFolder} onClose={()=>setSharingFolder(null)}/>,document.body)}
      {sharingNote&&createPortal(<ShareDialog onClose={()=>setSharingNote(false)}/>,document.body)}
      {/* Context menu */}
      {menu && (
        <div
          data-menu-panel="true"
          className="fixed z-[70] w-max min-w-36 max-w-56 overflow-y-auto overscroll-contain rounded-lg py-1 text-sm shadow-lg"
          style={{
            left: menuPos?.left ?? menu.x,
            top: menuPos?.top ?? menu.y,
            maxHeight: `calc(100vh - ${(menuPos?.top ?? menu.y) + MENU_EDGE_PADDING}px)`,
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            boxShadow: "0 8px 24px var(--shadow)",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {menuNode ? (
            <>
              {menuNode.is_dir && (
                <>
                  <MenuItem
                    onClick={() => {
                      requestNewFile(menuNode.path);
                      setMenu(null);
                    }}
                  >
                    {tr("新建笔记")}</MenuItem>
                  <MenuItem
                    onClick={() => {
                      requestNewRawFile(menuNode.path);
                      setMenu(null);
                    }}
                  >
                    {tr("新建文件")}</MenuItem>
                  <MenuItem
                    onClick={() => {
                      requestNewFolder(menuNode.path);
                      setMenu(null);
                    }}
                  >
                    {tr("新建文件夹")}</MenuItem>
                </>
              )}
              {!menuNode.is_dir && (
                <>
                  <MenuItem
                    onClick={() => {
                      requestNewFile(dirname(menuNode.path));
                      setMenu(null);
                    }}
                  >
                    {tr("同级新建笔记")}</MenuItem>
                  <MenuItem
                    onClick={() => {
                      requestNewRawFile(dirname(menuNode.path));
                      setMenu(null);
                    }}
                  >
                    {tr("同级新建文件")}</MenuItem>
                  <MenuItem
                    onClick={() => {
                      requestNewFolder(dirname(menuNode.path));
                      setMenu(null);
                    }}
                  >
                    {tr("同级新建文件夹")}</MenuItem>
                </>
              )}
              <MenuItem
                onClick={() => {
                  void createGitignore(menuNode.is_dir ? menuNode.path : dirname(menuNode.path));
                  setMenu(null);
                }}
              >
                {tr("新建 .gitignore")}</MenuItem>
              <SubMenuItem label={tr("复制")}>
                <MenuItem
                  hint="⌘C"
                  onClick={() => {
                    copyNodesToClipboard(menuPaths);
                    setMenu(null);
                  }}
                >
                  {menuHasMultiple
                    ? tr("复制 {{0}} 个项目", { 0: menuPaths.length })
                    : menuNode.is_dir
                      ? tr("复制文件夹")
                      : tr("复制文件")}
                </MenuItem>
                <SubMenuItem label={tr("复制路径")} disabled={menuHasMultiple}>
                  <MenuItem
                    onClick={() => {
                      void copyText(menuNode.path);
                      setMenu(null);
                    }}
                  >
                    {tr("绝对路径")}</MenuItem>
                  <MenuItem
                    onClick={() => {
                      void copyText(relativePath(menuNode.path, workspacePath));
                      setMenu(null);
                    }}
                  >
                    {tr("相对路径")}</MenuItem>
                </SubMenuItem>
                <MenuItem
                  disabled={menuHasMultiple}
                  onClick={() => {
                    void copyText(basename(menuNode.path));
                    setMenu(null);
                  }}
                >
                  {tr("复制文件名")}</MenuItem>
              </SubMenuItem>
              <MenuItem
                hint="⌘V"
                onClick={() => {
                  void pasteInto(menuNode.is_dir ? menuNode.path : dirname(menuNode.path));
                  setMenu(null);
                }}
              >
                {tr("粘贴")}</MenuItem>
              <MenuItem
                onClick={() => {
                  void revealItemInDir(menuNode.path);
                  setMenu(null);
                }}
              >
                {tr("打开所在目录")}</MenuItem>
              <MenuItem
                onClick={() => {
                  showFileInfo(menuNode.path).catch((err) => {
                    window.alert(tr("显示简介失败：{{0}}", { 0: err }));
                  });
                  setMenu(null);
                }}
              >
                {tr("显示简介")}</MenuItem>
              {/* History needs a repo; the file-level diff is text-only, so
                  images only get history at folder granularity. */}
              {gitInfo?.isRepo && (menuNode.is_dir || !isImageFile(menuNode.path)) && (
                <MenuItem
                  onClick={() => {
                    openHistoryAt(menuNode.path, menuNode.is_dir ? "dir" : "file");
                    setMenu(null);
                  }}
                >
                  {menuNode.is_dir ? tr("文件夹历史") : tr("文件历史")}
                </MenuItem>
              )}
              <MenuItem
                onClick={() => {
                  requestRename(menuNode.path);
                  setMenu(null);
                }}
              >
                {tr("重命名")}</MenuItem>
              <MenuItem
                danger
                hint={isMac ? "⌫" : "Delete"}
                onClick={() => {
                  removeMany(menuPaths);
                  setMenu(null);
                }}
              >
                {menuHasMultiple ? tr("删除 {{0}} 个项目", { 0: menuPaths.length }) : tr("删除")}
              </MenuItem>
              {gitInfo?.isRepo && workspacePath && (
                <MenuItem
                  title={tr("写入仓库根目录的 .gitignore；已跟踪文件仍会继续同步")}
                  onClick={() => {
                    void addToGitignore(menuPaths);
                    setMenu(null);
                  }}
                >
                  {tr("添加到 .gitignore")}</MenuItem>
              )}
              {menuNode.is_dir && (
                <MenuItem
                  disabled={menuHasMultiple}
                  onClick={() => {
                    setSharingFolder(menuNode.path);
                    setMenu(null);
                  }}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <Share2 size={15} className="shrink-0" style={{ color: "var(--text-muted)" }} aria-hidden="true" />
                    <span className="truncate">{tr("分享文件夹")}</span>
                  </span>
                </MenuItem>
              )}
              {!menuNode.is_dir && isMarkdownFile(menuNode.path) && (
                <MenuItem
                  disabled={menuHasMultiple}
                  onClick={() => {
                    const path = menuNode.path;
                    setMenu(null);
                    // The note dialog shares the active note, so open it first.
                    void openFile(path).then(() => {
                      if (useAppStore.getState().activeFilePath === path) setSharingNote(true);
                    });
                  }}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <Share2 size={15} className="shrink-0" style={{ color: "var(--text-muted)" }} aria-hidden="true" />
                    <span className="truncate">{tr("分享笔记")}</span>
                  </span>
                </MenuItem>
              )}
            </>
          ) : (
            <>
              <MenuItem
                onClick={() => {
                  requestNewFile();
                  setMenu(null);
                }}
              >
                {tr("新建笔记")}</MenuItem>
              <MenuItem
                onClick={() => {
                  requestNewRawFile();
                  setMenu(null);
                }}
              >
                {tr("新建文件")}</MenuItem>
              <MenuItem
                onClick={() => {
                  requestNewFolder();
                  setMenu(null);
                }}
              >
                {tr("新建文件夹")}</MenuItem>
              <MenuItem
                onClick={() => {
                  void createGitignore(workspacePath);
                  setMenu(null);
                }}
              >
                {tr("新建 .gitignore")}</MenuItem>
              <MenuItem
                hint="⌘V"
                onClick={() => {
                  if (workspacePath) void pasteInto(workspacePath);
                  setMenu(null);
                }}
              >
                {tr("粘贴")}</MenuItem>
              <MenuItem
                onClick={() => {
                  if (workspacePath) void revealItemInDir(workspacePath);
                  setMenu(null);
                }}
              >
                {tr("打开所在目录")}</MenuItem>
              <MenuItem
                onClick={() => {
                  if (workspacePath) {
                    showFileInfo(workspacePath).catch((err) => {
                      window.alert(tr("显示简介失败：{{0}}", { 0: err }));
                    });
                  }
                  setMenu(null);
                }}
              >
                {tr("显示简介")}</MenuItem>
              {gitInfo?.isRepo && workspacePath && (
                <MenuItem
                  onClick={() => {
                    openHistoryAt(workspacePath, "dir");
                    setMenu(null);
                  }}
                >
                  {tr("项目历史")}</MenuItem>
              )}
              <MenuItem
                onClick={() => {
                  void refreshTree();
                  setMenu(null);
                }}
              >
                {tr("刷新")}</MenuItem>
              <MenuItem
                onClick={() => {
                  if (workspacePath) setSharingFolder(workspacePath);
                  setMenu(null);
                }}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <Share2 size={15} className="shrink-0" style={{ color: "var(--text-muted)" }} aria-hidden="true" />
                  <span className="truncate">{tr("分享文件夹")}</span>
                </span>
              </MenuItem>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function IconButton({
  title,
  onClick,
  children,
  disabled = false,
  compact = false,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
  /** Narrower hit area for the crowded sidebar header. */
  compact?: boolean;
}) {
  useLanguage();
  return (
    <button
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`flex h-7 ${compact ? "w-6" : "w-7"} items-center justify-center rounded-md transition-colors disabled:cursor-default`}
      style={{ color: "var(--text-muted)", opacity: disabled ? 0.4 : 1 }}
      onMouseEnter={(e) => {
        if (disabled) return;
        e.currentTarget.style.background = "var(--hover)";
        e.currentTarget.style.color = "var(--text)";
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

/** Header IconButton that toggles a dropdown; stays highlighted while open. */
function IconMenuButton({
  title,
  open,
  onClick,
  children,
}: {
  title: string;
  open: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  useLanguage();
  return (
    <button
      title={title}
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="flex h-7 w-6 items-center justify-center rounded-md transition-colors"
      style={{
        color: open ? "var(--text)" : "var(--text-muted)",
        background: open ? "var(--hover)" : "transparent",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--hover)";
        e.currentTarget.style.color = "var(--text)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = open ? "var(--hover)" : "transparent";
        e.currentTarget.style.color = open ? "var(--text)" : "var(--text-muted)";
      }}
    >
      {children}
    </button>
  );
}

/**
 * Footer "导出" button that opens a small dropdown. It sits at the bottom of the
 * window, so the menu is anchored above the trigger. Currently holds just 打印;
 * add more <ExportMenuItem>s here to extend it (导出 PDF/Word/HTML…).
 */
function ExportMenu() {
  useLanguage();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ right: number; bottom: number } | null>(
    null,
  );
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Export/print only makes sense for the markdown pipeline; with anything
  // else (image, JSON, no file at all) the trigger is disabled outright.
  const activeFilePath = useAppStore((s) => s.activeFilePath);
  const exportable = !!activeFilePath && isMarkdownFile(activeFilePath);

  // Close a menu left open when the active file switches to a non-markdown one.
  useEffect(() => {
    if (!exportable) setOpen(false);
  }, [exportable]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!triggerRef.current?.contains(t) && !menuRef.current?.contains(t))
        setOpen(false);
    };
    const close = () => setOpen(false);
    // Window capture: Tauri's drag-region handler stops mousedown at the document.
    window.addEventListener("mousedown", onDoc, true);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("mousedown", onDoc, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);

  const toggle = () => {
    const r = triggerRef.current?.getBoundingClientRect();
    if (r)
      // Anchor the menu above the trigger, right-aligned to it.
      setPos({
        right: Math.round(window.innerWidth - r.right),
        bottom: Math.round(window.innerHeight - r.top + 6),
      });
    setOpen((v) => !v);
  };

  return (
    <>
      <button
        ref={triggerRef}
        title={exportable ? tr("导出") : tr("打开 Markdown 笔记后可导出")}
        disabled={!exportable}
        onClick={toggle}
        className="flex h-7 w-7 items-center justify-center rounded-md transition-colors"
        style={{
          color: open ? "var(--text)" : "var(--text-muted)",
          background: open ? "var(--hover)" : "transparent",
          opacity: exportable ? 1 : 0.4,
          cursor: exportable ? "pointer" : "default",
        }}
        onMouseEnter={(e) => {
          if (!exportable) return;
          e.currentTarget.style.background = "var(--hover)";
          e.currentTarget.style.color = "var(--text)";
        }}
        onMouseLeave={(e) => {
          if (open) return;
          e.currentTarget.style.background = "transparent";
          e.currentTarget.style.color = "var(--text-muted)";
        }}
      >
        <Download size={15} />
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            className="fixed z-[70] rounded-lg py-1"
            style={{
              right: pos.right,
              bottom: pos.bottom,
              minWidth: 136,
              background: "var(--bg-elev)",
              border: "1px solid var(--border)",
              boxShadow: "0 8px 24px var(--shadow)",
            }}
          >
            <ExportMenuItem
              icon={<FileDown size={14} />}
              label={tr("导出 PDF")}
              onClick={() => {
                setOpen(false);
                void exportCurrentNoteAsPdf();
              }}
            />
            <ExportMenuItem
              icon={<Printer size={14} />}
              label={tr("打印")}
              onClick={() => {
                setOpen(false);
                void printCurrentNote();
              }}
            />
          </div>,
          document.body,
        )}
    </>
  );
}

/** A single row in the ExportMenu dropdown. */
function ExportMenuItem({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  useLanguage();
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors"
      style={{ color: "var(--text)" }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--hover)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
      }}
    >
      {icon}
      <span className="flex-1">{label}</span>
    </button>
  );
}

function SearchModeButton({
  active,
  onClick,
}: {
  active: boolean;
  onClick: () => void;
}) {
  useLanguage();
  return (
    <button
      title={active ? tr("关闭全局搜索") : tr("全局搜索 (⌘⇧F)")}
      onClick={onClick}
      className="flex h-7 w-6 shrink-0 items-center justify-center rounded-md transition-colors"
      style={{
        color: active ? "var(--accent)" : "var(--text-muted)",
        background: active ? "var(--active)" : "transparent",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = active ? "var(--active)" : "var(--hover)";
        e.currentTarget.style.color = active ? "var(--accent)" : "var(--text)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = active ? "var(--active)" : "transparent";
        e.currentTarget.style.color = active ? "var(--accent)" : "var(--text-muted)";
      }}
    >
      {active ? <X size={15} /> : <Search size={15} />}
    </button>
  );
}

/** One segment of the glued-together sidebar mode switcher (tab-like). */
function SegmentButton({
  title,
  active,
  withDivider,
  onClick,
  children,
}: {
  title: string;
  active: boolean;
  withDivider: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  useLanguage();
  return (
    <button
      title={title}
      onClick={onClick}
      className="flex h-[26px] min-w-0 flex-1 items-center justify-center transition-colors"
      style={{
        color: active ? "var(--accent)" : "var(--text-muted)",
        background: active ? "var(--active)" : "transparent",
        borderLeft: withDivider ? "1px solid var(--border)" : "none",
      }}
      onMouseEnter={(e) => {
        if (!active) {
          e.currentTarget.style.background = "var(--hover)";
          e.currentTarget.style.color = "var(--text)";
        }
      }}
      onMouseLeave={(e) => {
        if (!active) {
          e.currentTarget.style.background = "transparent";
          e.currentTarget.style.color = "var(--text-muted)";
        }
      }}
    >
      {children}
    </button>
  );
}

function MenuItem({
  onClick,
  children,
  danger,
  title,
  hint,
  disabled = false,
}: {
  onClick: () => void;
  children: React.ReactNode;
  danger?: boolean;
  title?: string;
  /** Right-aligned shortcut hint, e.g. "⌘C". */
  hint?: string;
  disabled?: boolean;
}) {
  useLanguage();
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left transition-colors disabled:cursor-default"
      style={{ color: danger ? "#e5484d" : "var(--text)", opacity: disabled ? 0.4 : 1 }}
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
