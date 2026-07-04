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
  FilePlus2,
  FolderPlus,
  X,
  Settings,
  Printer,
  Download,
  FileDown,
  ChevronRight,
  ChevronDown,
} from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { getVersion } from "@tauri-apps/api/app";
import { useAppStore, type SidebarMode } from "../../store/useAppStore";
import {
  basename,
  dirname,
  findNode,
  isImageFile,
  isMarkdownFile,
  showFileInfo,
  type FileNode,
} from "../../lib/fs";
import {
  copyText,
  copyFileToClipboard,
  pasteFromClipboard,
  relativePath,
} from "../../lib/clipboard";
import {
  exportCurrentNoteAsPdf,
  printCurrentNote,
} from "../../lib/print/printNote";
import { FileTree } from "./FileTree";
import { NotesTree } from "./NotesTree";
import { OutlinePanel } from "./OutlinePanel";
import { SearchPanel } from "./SearchPanel";

type BrowseSidebarMode = Exclude<SidebarMode, "search">;

const MODES: { id: BrowseSidebarMode; title: string; icon: React.ReactNode }[] = [
  { id: "files", title: "文件模式", icon: <Folder size={14} /> },
  { id: "notes", title: "笔记模式", icon: <NotebookText size={14} /> },
  { id: "outline", title: "预览大纲", icon: <TableOfContents size={14} /> },
];

interface MenuState {
  x: number;
  y: number;
  /** The right-clicked node, or null for the blank area (workspace root). */
  node: FileNode | null;
}

const MENU_EDGE_PADDING = 8;
const SIDEBAR_MENU_WIDTH = 144;
const MENU_ROW_HEIGHT = 32;
const MENU_VERTICAL_PADDING = 8;

function estimateContextMenuHeight(
  node: FileNode | null,
  workspacePath: string | null,
  gitRepo: boolean,
): number {
  const rows = node
    ? (node.is_dir ? 3 : 2) +
      1 + // 复制 submenu
      1 + // 粘贴
      1 + // 打开所在目录
      1 + // 显示简介
      (gitRepo && (node.is_dir || !isImageFile(node.path)) ? 1 : 0) +
      1 + // 重命名
      1 // 删除
    : 3 +
      1 + // 粘贴
      1 + // 打开所在目录
      1 + // 显示简介
      (gitRepo && workspacePath ? 1 : 0) +
      1; // 刷新
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
  const workspacePath = useAppStore((s) => s.workspacePath);
  const tree = useAppStore((s) => s.tree);
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
  const clearSelection = useAppStore((s) => s.clearSelection);
  const requestNewFile = useAppStore((s) => s.requestNewFile);
  const requestNewRawFile = useAppStore((s) => s.requestNewRawFile);
  const requestNewFolder = useAppStore((s) => s.requestNewFolder);
  const requestRename = useAppStore((s) => s.requestRename);
  const remove = useAppStore((s) => s.remove);
  const openSettings = useAppStore((s) => s.openSettings);
  const openNewWindow = useAppStore((s) => s.openNewWindow);
  const compactSidebar = useAppStore((s) => s.compactSidebar);
  const uiZoom = useAppStore((s) => s.uiZoom);
  const gitInfo = useAppStore((s) => s.gitInfo);
  const openHistoryAt = useAppStore((s) => s.openHistoryAt);

  const [menu, setMenu] = useState<MenuState | null>(null);
  const [wsMenuOpen, setWsMenuOpen] = useState(false);
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
  // layer, so subpixel text re-rasterises crisply — and drive scrolling by hand.
  // Native `onWheel` is registered passive by React, so attach manually to be
  // able to preventDefault.
  const zoomed = Math.abs(uiZoom - 1) > 0.001;
  useEffect(() => {
    const el = listRef.current;
    if (!el || !zoomed) return;
    const onWheel = (e: WheelEvent) => {
      if (el.scrollHeight <= el.clientHeight) return;
      e.preventDefault();
      el.scrollTop += e.deltaY;
      el.scrollLeft += e.deltaX;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomed]);

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
    };
    if (menu || wsMenuOpen) {
      window.addEventListener("click", close);
      window.addEventListener("scroll", close, true);
      return () => {
        window.removeEventListener("click", close);
        window.removeEventListener("scroll", close, true);
      };
    }
  }, [menu, wsMenuOpen]);

  const openContextMenu = (e: React.MouseEvent, node: FileNode) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, node });
  };

  // Blank area of the list = the workspace root (rows stopPropagation).
  const openRootContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    // File operations don't apply to the search results list.
    if (!workspacePath || sidebarMode === "search") return;
    setMenu({ x: e.clientX, y: e.clientY, node: null });
  };

  const copyNodeToClipboard = (path: string) => {
    copyFileToClipboard(path).catch((err) => {
      window.alert(`复制失败：${err}`);
    });
  };

  const pasteInto = async (dir: string) => {
    try {
      await pasteFromClipboard(dir);
      await refreshTree();
    } catch (err) {
      window.alert(`粘贴失败：${err}`);
    }
  };

  /** Paste destination: the selected folder, a selected file's parent, or root. */
  const pasteTarget = (): string | null => {
    if (!workspacePath) return null;
    if (!selectedPath) return workspacePath;
    const node = findNode(tree, selectedPath);
    if (node?.is_dir) return node.path;
    return dirname(selectedPath);
  };

  // ⌘C / ⌘V on the file list (the list container takes focus when clicked).
  const onListKeyDown = (e: React.KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    const key = e.key.toLowerCase();
    if (key === "c" && selectedPath) {
      e.preventDefault();
      copyNodeToClipboard(selectedPath);
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
                setWsMenuOpen((v) => !v);
              }}
              title={workspacePath ?? "打开文件夹"}
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
                {workspacePath ? basename(workspacePath) : "未打开工作区"}
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
                    <AppWindow size={14} /> 新窗口
                  </span>
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    void requestOpenWorkspace();
                    setWsMenuOpen(false);
                  }}
                >
                  <span className="flex items-center gap-2">
                    <FolderOpen size={14} /> 打开文件夹
                  </span>
                </MenuItem>
                {workspacePath && (
                  <MenuItem
                    onClick={() => {
                      void closeWorkspace();
                      setWsMenuOpen(false);
                    }}
                  >
                    <span className="flex items-center gap-2">
                      <FolderX size={14} /> 关闭当前项目
                    </span>
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
                      <Folders size={14} /> 关闭所有项目
                    </span>
                  </MenuItem>
                )}
                <SubMenuItem label="最近的项目">
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
                      暂无记录
                    </div>
                  )}
                </SubMenuItem>
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            {workspacePath && (
              <>
                <IconButton
                  title="新建文件"
                  onClick={() => requestNewRawFile(pasteTarget() ?? undefined)}
                >
                  <FilePlus2 size={15} />
                </IconButton>
                <IconButton
                  title="新建文件夹"
                  onClick={() => requestNewFolder(pasteTarget() ?? undefined)}
                >
                  <FolderPlus size={15} />
                </IconButton>
              </>
            )}
            <SearchModeButton active={searchActive} onClick={toggleSearchMode} />
            {workspacePath && (
              <IconButton title="刷新文件列表" onClick={handleRefresh}>
                <RefreshCw
                  size={15}
                  className={refreshing ? "animate-spin" : undefined}
                />
              </IconButton>
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
      <div
        ref={listRef}
        tabIndex={0}
        onScroll={onListScroll}
        onContextMenu={openRootContextMenu}
        onKeyDown={onListKeyDown}
        // Clicking empty space (not a row) drops the multi-selection.
        onClick={(e) => {
          if (!(e.target as HTMLElement).closest("[data-tree-path]")) clearSelection();
        }}
        className={`scroll-auto-hide flex-1 outline-none ${
          zoomed ? "overflow-hidden" : "overflow-y-auto"
        } ${compactSidebar ? "py-0.5" : "py-1"}`}
        style={{
          fontSize:
            sidebarMode === "files" || sidebarMode === "search"
              ? "var(--sidebar-files-font-size)"
              : sidebarMode === "notes"
                ? "var(--sidebar-notes-font-size)"
                : "var(--sidebar-outline-font-size)",
        }}
      >
        {workspacePath ? (
          sidebarMode === "search" ? (
            <SearchPanel />
          ) : sidebarMode === "outline" ? (
            <OutlinePanel />
          ) : sidebarMode === "notes" ? (
            <NotesTree nodes={tree} onContextMenu={openContextMenu} />
          ) : tree.length ? (
            <FileTree nodes={tree} onContextMenu={openContextMenu} />
          ) : (
            <p
              className="px-4 py-6 text-center text-xs"
              style={{ color: "var(--text-muted)" }}
            >
              这个文件夹是空的。
            </p>
          )
        ) : (
          <button
            onClick={openWorkspace}
            className="mx-3 mt-4 flex w-[calc(100%-1.5rem)] items-center justify-center gap-2 rounded-lg py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
            style={{ background: "var(--accent)" }}
          >
            <FolderOpen size={16} /> 打开文件夹
          </button>
        )}
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
            Idea Note
          </span>
          {appVersion && (
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
          <IconButton title="设置" onClick={openSettings}>
            <Settings size={15} />
          </IconButton>
        </div>
      </div>

      {/* Context menu */}
      {menu && (
        <div
          data-menu-panel="true"
          className="fixed z-[70] w-36 overflow-y-auto overscroll-contain rounded-lg py-1 text-sm shadow-lg"
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
                    新建笔记
                  </MenuItem>
                  <MenuItem
                    onClick={() => {
                      requestNewRawFile(menuNode.path);
                      setMenu(null);
                    }}
                  >
                    新建文件
                  </MenuItem>
                  <MenuItem
                    onClick={() => {
                      requestNewFolder(menuNode.path);
                      setMenu(null);
                    }}
                  >
                    新建文件夹
                  </MenuItem>
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
                    同级新建笔记
                  </MenuItem>
                  <MenuItem
                    onClick={() => {
                      requestNewRawFile(dirname(menuNode.path));
                      setMenu(null);
                    }}
                  >
                    同级新建文件
                  </MenuItem>
                </>
              )}
              <SubMenuItem label="复制">
                <MenuItem
                  hint="⌘C"
                  onClick={() => {
                    copyNodeToClipboard(menuNode.path);
                    setMenu(null);
                  }}
                >
                  {menuNode.is_dir ? "复制文件夹" : "复制文件"}
                </MenuItem>
                <SubMenuItem label="复制路径">
                  <MenuItem
                    onClick={() => {
                      void copyText(menuNode.path);
                      setMenu(null);
                    }}
                  >
                    绝对路径
                  </MenuItem>
                  <MenuItem
                    onClick={() => {
                      void copyText(relativePath(menuNode.path, workspacePath));
                      setMenu(null);
                    }}
                  >
                    相对路径
                  </MenuItem>
                </SubMenuItem>
                <MenuItem
                  onClick={() => {
                    void copyText(basename(menuNode.path));
                    setMenu(null);
                  }}
                >
                  复制文件名
                </MenuItem>
              </SubMenuItem>
              <MenuItem
                hint="⌘V"
                onClick={() => {
                  void pasteInto(menuNode.is_dir ? menuNode.path : dirname(menuNode.path));
                  setMenu(null);
                }}
              >
                粘贴
              </MenuItem>
              <MenuItem
                onClick={() => {
                  void revealItemInDir(menuNode.path);
                  setMenu(null);
                }}
              >
                打开所在目录
              </MenuItem>
              <MenuItem
                onClick={() => {
                  showFileInfo(menuNode.path).catch((err) => {
                    window.alert(`显示简介失败：${err}`);
                  });
                  setMenu(null);
                }}
              >
                显示简介
              </MenuItem>
              {/* History needs a repo; the file-level diff is text-only, so
                  images only get history at folder granularity. */}
              {gitInfo?.isRepo && (menuNode.is_dir || !isImageFile(menuNode.path)) && (
                <MenuItem
                  onClick={() => {
                    openHistoryAt(menuNode.path, menuNode.is_dir ? "dir" : "file");
                    setMenu(null);
                  }}
                >
                  {menuNode.is_dir ? "文件夹历史" : "文件历史"}
                </MenuItem>
              )}
              <MenuItem
                onClick={() => {
                  requestRename(menuNode.path);
                  setMenu(null);
                }}
              >
                重命名
              </MenuItem>
              <MenuItem
                danger
                onClick={() => {
                  remove(menuNode.path);
                  setMenu(null);
                }}
              >
                删除
              </MenuItem>
            </>
          ) : (
            <>
              <MenuItem
                onClick={() => {
                  requestNewFile();
                  setMenu(null);
                }}
              >
                新建笔记
              </MenuItem>
              <MenuItem
                onClick={() => {
                  requestNewRawFile();
                  setMenu(null);
                }}
              >
                新建文件
              </MenuItem>
              <MenuItem
                onClick={() => {
                  requestNewFolder();
                  setMenu(null);
                }}
              >
                新建文件夹
              </MenuItem>
              <MenuItem
                hint="⌘V"
                onClick={() => {
                  if (workspacePath) void pasteInto(workspacePath);
                  setMenu(null);
                }}
              >
                粘贴
              </MenuItem>
              <MenuItem
                onClick={() => {
                  if (workspacePath) void revealItemInDir(workspacePath);
                  setMenu(null);
                }}
              >
                打开所在目录
              </MenuItem>
              <MenuItem
                onClick={() => {
                  if (workspacePath) {
                    showFileInfo(workspacePath).catch((err) => {
                      window.alert(`显示简介失败：${err}`);
                    });
                  }
                  setMenu(null);
                }}
              >
                显示简介
              </MenuItem>
              {gitInfo?.isRepo && workspacePath && (
                <MenuItem
                  onClick={() => {
                    openHistoryAt(workspacePath, "dir");
                    setMenu(null);
                  }}
                >
                  项目历史
                </MenuItem>
              )}
              <MenuItem
                onClick={() => {
                  void refreshTree();
                  setMenu(null);
                }}
              >
                刷新
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
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className="flex h-7 w-7 items-center justify-center rounded-md transition-colors"
      style={{ color: "var(--text-muted)" }}
      onMouseEnter={(e) => {
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

/**
 * Footer "导出" button that opens a small dropdown. It sits at the bottom of the
 * window, so the menu is anchored above the trigger. Currently holds just 打印;
 * add more <ExportMenuItem>s here to extend it (导出 PDF/Word/HTML…).
 */
function ExportMenu() {
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
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("mousedown", onDoc);
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
        title={exportable ? "导出" : "打开 Markdown 笔记后可导出"}
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
              label="导出 PDF"
              onClick={() => {
                setOpen(false);
                void exportCurrentNoteAsPdf();
              }}
            />
            <ExportMenuItem
              icon={<Printer size={14} />}
              label="打印"
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
  return (
    <button
      title={active ? "关闭全局搜索" : "全局搜索 (⌘⇧F)"}
      onClick={onClick}
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors"
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

/** Menu row that reveals a nested panel to the right while hovered. */
function SubMenuItem({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  // The panel is portaled to <body> with fixed coordinates — rendered in
  // place it would be clipped by the sidebar's overflow and sit under the
  // sidebar/editor divider. A short close delay keeps it open while the
  // pointer crosses the 2px overlap between the row and the panel.
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | undefined>(undefined);
  const show = () => {
    window.clearTimeout(closeTimer.current);
    const r = rowRef.current?.getBoundingClientRect();
    if (r) {
      setPos({ top: r.top, left: Math.min(r.right - 2, window.innerWidth - 150) });
    }
  };
  const hide = () => {
    closeTimer.current = window.setTimeout(() => setPos(null), 120);
  };
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  return (
    <div ref={rowRef} onMouseEnter={show} onMouseLeave={hide}>
      <button
        className="flex w-full items-center justify-between px-3 py-1.5 text-left transition-colors"
        style={{
          color: "var(--text)",
          background: pos ? "var(--hover)" : "transparent",
        }}
      >
        {label}
        <ChevronRight size={13} style={{ color: "var(--text-muted)" }} />
      </button>
      {pos &&
        createPortal(
          <div
            data-menu-panel="true"
            className="fixed z-[70] w-36 overflow-y-auto overscroll-contain rounded-lg py-1 text-sm shadow-lg"
            style={{
              top: pos.top,
              left: pos.left,
              maxHeight: `calc(100vh - ${pos.top + 8}px)`,
              background: "var(--bg-elev)",
              border: "1px solid var(--border)",
              boxShadow: "0 8px 24px var(--shadow)",
            }}
            onMouseEnter={show}
            onMouseLeave={hide}
          >
            {children}
          </div>,
          document.body,
        )}
    </div>
  );
}

function MenuItem({
  onClick,
  children,
  danger,
  title,
  hint,
}: {
  onClick: () => void;
  children: React.ReactNode;
  danger?: boolean;
  title?: string;
  /** Right-aligned shortcut hint, e.g. "⌘C". */
  hint?: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left transition-colors"
      style={{ color: danger ? "#e5484d" : "var(--text)" }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--hover)")}
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
