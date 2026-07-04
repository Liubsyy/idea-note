import { ChevronLeft, ChevronRight, FileText, Image as ImageIcon, Plus, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { isDraftPath, useAppStore } from "../../store/useAppStore";
import { basename, isImageFile } from "../../lib/fs";
import { copyFileToClipboard, copyText, relativePath } from "../../lib/clipboard";

/**
 * Horizontal strip of open-file tabs, shown above the editor toolbar whenever
 * at least one file is open. Click a tab to activate it, ✕ (or middle-click) to
 * close. Only the active tab can be dirty — its unsaved state shows as a dot
 * that turns into the close button on hover.
 *
 * The tab area spans ~80% of the width; when its tabs overflow, left/right
 * chevron buttons appear to scroll it. A trailing ＋ button opens a new empty
 * "untitled" draft.
 */
export function EditorTabs() {
  const openTabs = useAppStore((s) => s.openTabs);
  const workspacePath = useAppStore((s) => s.workspacePath);
  const activeFilePath = useAppStore((s) => s.activeFilePath);
  const isDirty = useAppStore((s) => s.isDirty);
  const openFile = useAppStore((s) => s.openFile);
  const closeTab = useAppStore((s) => s.closeTab);
  const closeOtherTabs = useAppStore((s) => s.closeOtherTabs);
  const closeAllTabs = useAppStore((s) => s.closeAllTabs);
  const newDraft = useAppStore((s) => s.newDraft);
  const reorderTabs = useAppStore((s) => s.reorderTabs);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  // Drag-to-reorder state: which tab is being dragged, and which slot it would
  // drop into. `dropIndex` marks the gap *before* that index (length = trailing).
  // Implemented with raw mouse events rather than native HTML5 drag-and-drop,
  // which the macOS WebView (Tauri) intercepts for file drops and won't fire.
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  // Set true once a press turns into an actual drag, so the trailing click that
  // the browser fires on pointerup doesn't get treated as a tab switch.
  const draggedRef = useRef(false);
  // Live press state: the pressed tab's index, where the press began, and
  // whether it has crossed the threshold into an actual drag.
  const pressRef = useRef<{ index: number; startX: number; started: boolean } | null>(null);

  // Given a pointer X, find the gap (0..length) the dragged tab would drop into,
  // by comparing against each rendered tab's horizontal midpoint.
  const computeDropIndex = useCallback((clientX: number) => {
    const el = scrollRef.current;
    if (!el) return 0;
    const tabs = Array.from(el.querySelectorAll<HTMLElement>("[data-tab-path]"));
    for (let i = 0; i < tabs.length; i++) {
      const rect = tabs[i].getBoundingClientRect();
      if (clientX < rect.left + rect.width / 2) return i;
    }
    return tabs.length;
  }, []);

  // Pointer-based drag-to-reorder. Pointer capture (set on pointerdown) routes
  // every move/up to the same tab element, so this keeps working even as the
  // list re-renders and regardless of the surrounding horizontal scroller —
  // unlike native HTML5 drag, which the macOS WebView swallows.
  const onTabPointerDown = useCallback((e: React.PointerEvent, index: number) => {
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pressRef.current = { index, startX: e.clientX, started: false };
    draggedRef.current = false;
  }, []);

  const onTabPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const press = pressRef.current;
      if (!press) return;
      if (!press.started) {
        if (Math.abs(e.clientX - press.startX) < 4) return;
        press.started = true;
        draggedRef.current = true;
        setDragIndex(press.index);
      }
      setDropIndex(computeDropIndex(e.clientX));
    },
    [computeDropIndex],
  );

  const onTabPointerUp = useCallback(
    (e: React.PointerEvent) => {
      const press = pressRef.current;
      pressRef.current = null;
      if (press?.started) {
        const drop = computeDropIndex(e.clientX);
        // Removing the dragged item shifts later targets left by one.
        const to = drop > press.index ? drop - 1 : drop;
        reorderTabs(press.index, to);
      }
      setDragIndex(null);
      setDropIndex(null);
    },
    [computeDropIndex, reorderTabs],
  );

  const updateArrows = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setCanLeft(el.scrollLeft > 1);
    setCanRight(el.scrollLeft < max - 1);
  }, []);

  // Recompute arrow visibility when the tab set changes or on resize.
  useLayoutEffect(() => {
    updateArrows();
  }, [openTabs, updateArrows]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(updateArrows);
    ro.observe(el);
    return () => ro.disconnect();
  }, [updateArrows]);

  // Keep the active tab visible when it changes (e.g. opened from the sidebar).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !activeFilePath) return;
    const node = el.querySelector<HTMLElement>(`[data-tab-path="${CSS.escape(activeFilePath)}"]`);
    node?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [activeFilePath]);

  const scrollBy = (dir: -1 | 1) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.max(el.clientWidth * 0.7, 160), behavior: "smooth" });
  };

  return (
    <div
      className="flex h-8 shrink-0 items-stretch"
      style={{ background: "var(--toolbar-bg)", borderBottom: "1px solid var(--border)" }}
    >
      {/* Tab area sizes to its tabs (so ＋ hugs the last one), but never spans
          more than ~90% of the strip — past that it scrolls. */}
      <div className="flex min-w-0 items-stretch" style={{ maxWidth: "90%" }}>
        {canLeft && <ArrowButton dir="left" onClick={() => scrollBy(-1)} />}
        <div
          ref={scrollRef}
          onScroll={updateArrows}
          className="editor-tabs-scroll flex min-w-0 items-stretch overflow-x-auto"
        >
          {openTabs.map((path, index) => {
            const active = path === activeFilePath;
            const dirty = active && isDirty;
            const draft = isDraftPath(path);
            const Icon = isImageFile(path) ? ImageIcon : FileText;
            const dragging = dragIndex === index;
            // Show the insertion bar on this tab's leading edge, or — for the
            // last slot — on the trailing edge of the final tab.
            const showBefore = dropIndex === index && dragIndex !== null;
            const showAfter =
              dropIndex === openTabs.length &&
              index === openTabs.length - 1 &&
              dragIndex !== null;
            return (
              <div
                key={path}
                data-tab-path={path}
                onClick={() => {
                  // Swallow the click that ends a drag so it doesn't switch tabs.
                  if (draggedRef.current) {
                    draggedRef.current = false;
                    return;
                  }
                  if (!active) void openFile(path);
                }}
                onMouseDown={(e) => {
                  // Middle-click closes the tab (standard browser/editor gesture).
                  if (e.button === 1) {
                    e.preventDefault();
                    void closeTab(path);
                  }
                }}
                onPointerDown={(e) => onTabPointerDown(e, index)}
                onPointerMove={onTabPointerMove}
                onPointerUp={onTabPointerUp}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ x: e.clientX, y: e.clientY, path });
                }}
                title={draft ? "未保存的草稿" : path}
                className="group relative flex max-w-[200px] shrink-0 cursor-pointer select-none items-center gap-1.5 pl-3 pr-1.5 text-[13px] transition-colors"
                style={{
                  background: active ? "var(--bg)" : "transparent",
                  color: active ? "var(--text)" : "var(--text-muted)",
                  borderRight: "1px solid var(--border)",
                  boxShadow: active ? "inset 0 2px 0 var(--accent)" : undefined,
                  opacity: dragging ? 0.4 : 1,
                }}
                onMouseEnter={(e) => {
                  if (!active) e.currentTarget.style.background = "var(--hover)";
                }}
                onMouseLeave={(e) => {
                  if (!active) e.currentTarget.style.background = "transparent";
                }}
              >
                {showBefore && <DropIndicator side="left" />}
                {showAfter && <DropIndicator side="right" />}
                <Icon size={13} className="shrink-0" style={{ color: "var(--text-muted)" }} />
                <span className="min-w-0 truncate">{draft ? "未命名" : basename(path)}</span>
                <button
                  title="关闭"
                  // Keep the tab's pointer-capture drag from starting here: with
                  // capture active, Chromium (Windows WebView2) retargets the
                  // ensuing click to the capturing tab, so this button's onClick
                  // would never fire (WebKit doesn't retarget, hence mac worked).
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    void closeTab(path);
                  }}
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-[var(--hover)]"
                >
                  {/* Dirty (always the active tab): dot at rest, ✕ on hover. Clean
                      active tab: ✕ always. Clean background tab: ✕ on hover only. */}
                  {dirty && (
                    <span
                      className="h-1.5 w-1.5 rounded-full group-hover:hidden"
                      style={{ background: "var(--accent)" }}
                    />
                  )}
                  <X
                    size={13}
                    className={
                      dirty
                        ? "hidden group-hover:block"
                        : active
                          ? ""
                          : "opacity-0 transition-opacity group-hover:opacity-100"
                    }
                    style={{ color: "var(--text-muted)" }}
                  />
                </button>
              </div>
            );
          })}
        </div>
        {canRight && <ArrowButton dir="right" onClick={() => scrollBy(1)} />}
        <button
          onClick={() => void newDraft()}
          title="新建空白页"
          className="flex w-8 shrink-0 items-center justify-center transition-colors hover:bg-[var(--hover)]"
          style={{ color: "var(--text-muted)", borderLeft: "1px solid var(--border)" }}
        >
          <Plus size={16} />
        </button>
      </div>
      {menu && (
        <TabContextMenu
          menu={menu}
          canCloseOthers={openTabs.length > 1}
          workspacePath={workspacePath}
          onClose={() => setMenu(null)}
          onCloseTab={() => void closeTab(menu.path)}
          onCloseOthers={() => void closeOtherTabs(menu.path)}
          onCloseAll={() => void closeAllTabs()}
        />
      )}
    </div>
  );
}

/** Vertical bar showing where a dragged tab will be inserted. */
function DropIndicator({ side }: { side: "left" | "right" }) {
  return (
    <span
      className="pointer-events-none absolute top-0 bottom-0 z-10 w-0.5"
      style={{ background: "var(--accent)", [side]: -1 }}
    />
  );
}

/** Right-click menu for a file tab. Mirrors the editor's context menu styling. */
function TabContextMenu({
  menu,
  canCloseOthers,
  workspacePath,
  onClose,
  onCloseTab,
  onCloseOthers,
  onCloseAll,
}: {
  menu: { x: number; y: number; path: string };
  canCloseOthers: boolean;
  workspacePath: string | null;
  onClose: () => void;
  onCloseTab: () => void;
  onCloseOthers: () => void;
  onCloseAll: () => void;
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

  const run = (action: () => void) => {
    onClose();
    action();
  };

  const copyTabFile = () => {
    copyFileToClipboard(menu.path).catch((err) => {
      window.alert(`复制失败：${err}`);
    });
  };
  const canCopy = !isDraftPath(menu.path);

  return (
    <div
      ref={panelRef}
      className="fixed z-50 w-36 rounded-lg py-1 text-sm shadow-lg"
      style={{
        left: Math.min(menu.x, window.innerWidth - 152),
        top: Math.min(menu.y, window.innerHeight - (canCopy ? 142 : 110)),
        background: "var(--bg-elev)",
        border: "1px solid var(--border)",
        boxShadow: "0 8px 24px var(--shadow)",
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {canCopy && (
        <SubMenuItem label="复制">
          <MenuItem hint="⌘C" onClick={() => run(copyTabFile)}>
            复制文件
          </MenuItem>
          <SubMenuItem label="复制路径">
            <MenuItem onClick={() => run(() => void copyText(menu.path))}>绝对路径</MenuItem>
            <MenuItem
              onClick={() => run(() => void copyText(relativePath(menu.path, workspacePath)))}
            >
              相对路径
            </MenuItem>
          </SubMenuItem>
          <MenuItem onClick={() => run(() => void copyText(basename(menu.path)))}>
            复制文件名
          </MenuItem>
        </SubMenuItem>
      )}
      <MenuItem onClick={() => run(onCloseTab)}>关闭</MenuItem>
      <MenuItem disabled={!canCloseOthers} onClick={() => run(onCloseOthers)}>
        关闭其他页
      </MenuItem>
      <MenuItem onClick={() => run(onCloseAll)}>关闭所有页</MenuItem>
    </div>
  );
}

function SubMenuItem({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        className="flex w-full items-center justify-between px-3 py-1.5 text-left transition-colors"
        style={{ color: "var(--text)", background: open ? "var(--hover)" : "transparent" }}
      >
        <span>{label}</span>
        <ChevronRight size={13} style={{ color: "var(--text-muted)" }} />
      </button>
      {open && (
        <div
          className="absolute left-[calc(100%-2px)] top-0 z-[60] w-36 rounded-lg py-1 text-sm shadow-lg"
          style={{
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            boxShadow: "0 8px 24px var(--shadow)",
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

function MenuItem({
  onClick,
  children,
  disabled,
  hint,
}: {
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-center gap-3 px-3 py-1.5 text-left transition-colors disabled:cursor-default"
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
/** Edge scroll button. Mirrors the toolbar background so it reads as chrome. */
function ArrowButton({ dir, onClick }: { dir: "left" | "right"; onClick: () => void }) {
  const Icon = dir === "left" ? ChevronLeft : ChevronRight;
  return (
    <button
      onClick={onClick}
      title={dir === "left" ? "向左滚动" : "向右滚动"}
      className="flex w-7 shrink-0 items-center justify-center transition-colors hover:bg-[var(--hover)]"
      style={{
        color: "var(--text-muted)",
        background: "var(--toolbar-bg)",
        [dir === "left" ? "borderRight" : "borderLeft"]: "1px solid var(--border)",
      }}
    >
      <Icon size={16} />
    </button>
  );
}
