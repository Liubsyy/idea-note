import { tr } from "../i18n/core.ts";
import { useLanguage } from "../i18n/react";
import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { createPortal } from "react-dom";
import { Plus } from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { basename, pickWorkspace } from "../lib/fs";
import {
  activateProjectTab,
  closeProjectTabWindow,
  detachProjectTab,
  DROP_TARGET_EVENT,
  dropProjectTab,
  hoverProjectTab,
  moveProjectTab,
  projectWorkspaceOf,
  type ProjectTab,
} from "../lib/projectTabs";
import { useAppStore } from "../store/useAppStore";

/** Rail width in px; App.tsx reserves it next to the sidebar. */
export const PROJECT_RAIL_WIDTH = 44;
/** A drag released this far right of the rail (or outside the window)
 *  moves the tab out instead of reordering: onto another project window to
 *  join its tabs, anywhere else into a new window. */
const DETACH_DISTANCE = 60;

/** One or two characters that tell projects apart at a glance: the first two
 *  CJK characters, the initials of a multi-word name, else its first two
 *  letters ("idea-note" → "IN", "blog" → "Bl", "工作笔记" → "工作"). */
export function projectInitials(name: string): string {
  const cjk = name.match(/^[㐀-鿿豈-﫿]{1,2}/);
  if (cjk) return cjk[0];
  const words = name.split(/[\s\-_.]+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  const word = words[0] ?? name;
  return word.slice(0, 1).toUpperCase() + word.slice(1, 2);
}

/** A stable hue per project name, so similar initials still differ. */
function projectHue(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) % 360;
  return h;
}

interface MenuState {
  tab: ProjectTab;
  x: number;
  y: number;
}

interface Press {
  label: string;
  startX: number;
  startY: number;
  started: boolean;
  /** Last pointer position, kept for a release the window never sees. */
  screen: { x: number; y: number };
  outside: boolean;
}

/** Minimum gap between drop-target lookups while dragging (ms). */
const HOVER_INTERVAL = 50;

/** Whether a drag at this point means "split into a new window". */
function isDetachPoint(clientX: number, clientY: number): boolean {
  return (
    clientX < 0 ||
    clientY < 0 ||
    clientX > window.innerWidth ||
    clientY > window.innerHeight ||
    clientX > PROJECT_RAIL_WIDTH + DETACH_DISTANCE
  );
}

/**
 * Left-edge rail listing the project tabs of this window's group. Each tab is
 * its own window stacked on the same frame; clicking one asks Rust to swap it
 * in. Shown only while the group has two or more projects.
 */
export function ProjectRail({ tabs, activeLabel }: { tabs: ProjectTab[]; activeLabel: string | null }) {
  useLanguage();
  const [menu, setMenu] = useState<MenuState | null>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const pressRef = useRef<Press | null>(null);
  // Swallows the click that follows a drag's pointerup.
  const draggedRef = useRef(false);
  const [drag, setDrag] = useState<{ label: string; drop: number; outside: boolean } | null>(null);
  /** Window a release right now would merge into (null = a new window). */
  const [target, setTarget] = useState<string | null>(null);
  const hoverRef = useRef({ at: 0, reported: false, timer: 0 });

  /** Ask Rust which window is under the cursor; it also lights that one up.
   *  Throttled, with a trailing call so the last position always counts. */
  const reportHover = (label: string, at: { x: number; y: number } | null) => {
    const hover = hoverRef.current;
    window.clearTimeout(hover.timer);
    if (at) {
      const wait = hover.at + HOVER_INTERVAL - performance.now();
      if (wait > 0) {
        hover.timer = window.setTimeout(() => reportHover(label, at), wait);
        return;
      }
      hover.at = performance.now();
    } else if (!hover.reported) {
      return;
    }
    hover.reported = !!at;
    void hoverProjectTab(label, at).then((t) => {
      if (pressRef.current?.label === label) setTarget(t);
    });
  };

  /** Rail index a drop at `clientY` lands before (tabs.length = at the end). */
  const dropIndexAt = (clientY: number) => {
    const items = railRef.current?.querySelectorAll<HTMLElement>("[data-project-tab]") ?? [];
    for (let i = 0; i < items.length; i++) {
      const rect = items[i].getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) return i;
    }
    return items.length;
  };

  // Pointer-based drag (the macOS WebView swallows native HTML5 drag, see
  // treeDrag.tsx). Pointer capture keeps the moves and the release coming to
  // the pressed tab even once the cursor leaves the rail or the window.
  const onPointerDown = (e: React.PointerEvent, tab: ProjectTab) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pressRef.current = {
      label: tab.label,
      startX: e.clientX,
      startY: e.clientY,
      started: false,
      screen: { x: e.screenX, y: e.screenY },
      outside: false,
    };
    draggedRef.current = false;
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const press = pressRef.current;
    if (!press) return;
    press.screen = { x: e.screenX, y: e.screenY };
    if (!press.started) {
      if (Math.hypot(e.clientX - press.startX, e.clientY - press.startY) < 4) return;
      press.started = true;
      draggedRef.current = true;
    }
    press.outside = isDetachPoint(e.clientX, e.clientY);
    setDrag({ label: press.label, drop: dropIndexAt(e.clientY), outside: press.outside });
    reportHover(press.label, press.outside ? press.screen : null);
  };

  const finishDrag = (release: { clientY: number } | null) => {
    const press = pressRef.current;
    pressRef.current = null;
    setDrag(null);
    setTarget(null);
    if (!press?.started) return;
    window.clearTimeout(hoverRef.current.timer);
    if (!press.outside) reportHover(press.label, null);
    hoverRef.current = { at: 0, reported: false, timer: 0 };
    if (press.outside) {
      void dropProjectTab(press.label, press.screen);
      return;
    }
    if (!release) return;
    const drop = dropIndexAt(release.clientY);
    const from = tabs.findIndex((t) => t.label === press.label);
    if (drop === from || drop === from + 1) return; // same place
    void moveProjectTab(press.label, tabs[drop]?.label ?? null);
  };

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  const addProject = async () => {
    const path = await pickWorkspace();
    if (path) await useAppStore.getState().openNewTab(path);
  };

  return (
    <div
      className="flex h-full shrink-0 flex-col items-center gap-2 overflow-y-auto py-2"
      style={{
        width: PROJECT_RAIL_WIDTH,
        background: "var(--sidebar-bg)",
        borderRight: "1px solid var(--border)",
        scrollbarWidth: "none",
      }}
      ref={railRef}
      data-project-rail
    >
      {tabs.map((tab, index) => {
        const name = tab.workspace ? basename(tab.workspace) : tr("未打开工作区");
        const hue = projectHue(name);
        const active = tab.label === activeLabel;
        return (
          <button
            key={tab.label}
            data-project-tab
            title={drag ? undefined : tab.workspace ? `${name}\n${tab.workspace}` : name}
            onPointerDown={(e) => onPointerDown(e, tab)}
            onPointerMove={onPointerMove}
            onPointerUp={(e) => finishDrag({ clientY: e.clientY })}
            onPointerCancel={() => finishDrag(null)}
            onLostPointerCapture={() => {
              if (pressRef.current) finishDrag(null);
            }}
            onClick={() => {
              if (draggedRef.current) {
                draggedRef.current = false;
                return;
              }
              if (!active) void activateProjectTab(tab.label);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ tab, x: e.clientX, y: e.clientY });
            }}
            className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[12px] font-semibold transition-shadow"
            style={{
              color: tab.workspace ? `hsl(${hue} 55% 42%)` : "var(--text-muted)",
              background: tab.workspace
                ? `color-mix(in srgb, hsl(${hue} 60% 50%) 14%, var(--bg))`
                : "var(--bg)",
              boxShadow: active ? "0 0 0 2px var(--accent)" : "inset 0 0 0 1px var(--border)",
              opacity: drag?.label === tab.label ? 0.4 : 1,
              touchAction: "none",
            }}
          >
            {drag && !drag.outside && drag.drop === index && <DropLine />}
            {tab.workspace ? projectInitials(name) : "—"}
            {tab.attention && !active && (
              <span
                className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full"
                style={{ background: "#f59e0b", boxShadow: "0 0 0 2px var(--sidebar-bg)" }}
                title={tr("等待你的操作")}
              />
            )}
          </button>
        );
      })}
      <button
        title={tr("在新标签中打开项目")}
        onClick={() => void addProject()}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors"
        style={{ position: "relative", color: "var(--text-muted)", border: "1px dashed var(--border)" }}
        onMouseEnter={(e) => (e.currentTarget.style.background = "var(--hover)")}
        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
      >
        {drag && !drag.outside && drag.drop === tabs.length && <DropLine />}
        <Plus size={15} />
      </button>

      {drag?.outside &&
        createPortal(
          <div
            className="pointer-events-none fixed bottom-4 left-4 z-[100] rounded-lg px-3 py-1.5 text-sm shadow-lg"
            style={{
              background: "var(--bg-elev)",
              border: "1px solid var(--border)",
              color: "var(--text)",
              boxShadow: "0 8px 24px var(--shadow)",
            }}
          >
            {target
              ? tr("松开以合并到「{{0}}」所在窗口", {
                  0: basename(projectWorkspaceOf(target) ?? "") || tr("未打开工作区"),
                })
              : tr("松开以在新窗口中打开，或拖到其他窗口上合并")}
          </div>,
          document.body,
        )}

      {menu &&
        createPortal(
          <div
            data-menu-panel="true"
            className="fixed z-[100] w-44 rounded-lg py-1 text-sm shadow-lg"
            style={{
              left: menu.x,
              top: Math.min(menu.y, window.innerHeight - 120),
              background: "var(--bg-elev)",
              border: "1px solid var(--border)",
              boxShadow: "0 8px 24px var(--shadow)",
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {menu.tab.workspace && (
              <RailMenuItem
                onClick={() => {
                  void revealItemInDir(menu.tab.workspace!);
                  setMenu(null);
                }}
              >
                {tr("打开所在目录")}
              </RailMenuItem>
            )}
            <RailMenuItem
              onClick={() => {
                void detachProjectTab(menu.tab.label);
                setMenu(null);
              }}
            >
              {tr("拆分到独立窗口")}
            </RailMenuItem>
            <RailMenuItem
              onClick={() => {
                void closeProjectTabWindow(menu.tab.label);
                setMenu(null);
              }}
            >
              {tr("关闭项目")}
            </RailMenuItem>
          </div>,
          document.body,
        )}
    </div>
  );
}

/**
 * Full-window highlight shown while another window's rail drag hovers over
 * this one: releasing there merges the dragged project into these tabs.
 */
export function MergeDropOverlay() {
  useLanguage();
  const [shown, setShown] = useState(false);
  useEffect(() => {
    let label: string | null = null;
    try {
      label = getCurrentWindow().label;
    } catch {
      return; // plain browser, no Tauri
    }
    const un = listen<string | null>(DROP_TARGET_EVENT, ({ payload }) => setShown(payload === label));
    return () => {
      un.then((fn) => fn());
    };
  }, []);
  if (!shown) return null;
  return createPortal(
    <div
      className="pointer-events-none fixed inset-0 z-[200] flex items-center justify-center"
      style={{
        background: "color-mix(in srgb, var(--accent) 8%, transparent)",
        boxShadow: "inset 0 0 0 3px var(--accent)",
      }}
    >
      <span
        className="rounded-lg px-4 py-2 text-sm font-medium"
        style={{ background: "var(--bg)", color: "var(--accent)", border: "1.5px dashed var(--accent)" }}
      >
        {tr("松开以合并到此窗口")}
      </span>
    </div>,
    document.body,
  );
}

/** Insertion marker drawn just above the tab a drop would land before. */
function DropLine() {
  return (
    <span
      className="pointer-events-none absolute -top-[6px] left-0 h-0.5 w-full rounded-full"
      style={{ background: "var(--accent)" }}
    />
  );
}

function RailMenuItem({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center px-3 py-1.5 text-left transition-colors"
      style={{ color: "var(--text)" }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--hover)")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      {children}
    </button>
  );
}
