import { useRef, useState } from "react";
import { Plus, SquareTerminal, X } from "lucide-react";
import { useAppStore } from "../../store/useAppStore";
import { basename } from "../../lib/fs";
import { TerminalView } from "./TerminalPanel";

/**
 * Bottom panel: a tabbed strip of integrated terminals over an xterm surface.
 * "+" spawns another terminal; the top border drags to resize the panel.
 *
 * Stays mounted while `visible` is false (hidden via CSS) so toggling the panel
 * preserves the running shells + scrollback — terminals are only killed when
 * their tab's × is clicked. `onAllClosed` fires when the last tab is closed.
 */
export function BottomPanel({
  visible,
  onAllClosed,
}: {
  visible: boolean;
  onAllClosed: () => void;
}) {
  const toggleBottomPanel = useAppStore((s) => s.toggleBottomPanel);
  const height = useAppStore((s) => s.bottomPanelHeight);
  const setHeight = useAppStore((s) => s.setBottomPanelHeight);
  const workspacePath = useAppStore((s) => s.workspacePath);
  const label = workspacePath ? basename(workspacePath) : "终端";

  const [tabs, setTabs] = useState<number[]>([1]);
  const [activeId, setActiveId] = useState(1);
  const nextId = useRef(2);

  const addTerminal = () => {
    const id = nextId.current++;
    setTabs((t) => [...t, id]);
    setActiveId(id);
  };

  const closeTab = (id: number) => {
    const next = tabs.filter((t) => t !== id);
    if (next.length === 0) {
      onAllClosed(); // last tab gone → tear the panel down
      return;
    }
    if (id === activeId) {
      const idx = tabs.indexOf(id);
      setActiveId(next[Math.min(idx, next.length - 1)]);
    }
    setTabs(next);
  };

  // Drag the top border to resize.
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = useAppStore.getState().bottomPanelHeight;
    const onMove = (ev: MouseEvent) => setHeight(startH - (ev.clientY - startY));
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
  };

  return (
    <div
      className={`relative flex shrink-0 flex-col ${visible ? "" : "hidden"}`}
      style={{ height, borderTop: "1px solid var(--border)", background: "var(--bg)" }}
    >
      {/* Resize grip sitting on the top border. */}
      <div
        onMouseDown={startResize}
        className="absolute inset-x-0 top-0 z-10 h-1.5 -translate-y-1/2 cursor-row-resize"
        title="拖动调整高度"
      />

      {/* Tab strip — same surface as the terminal below (no divider) so the
          tab, +, and command line read as one panel. */}
      <div
        className="flex h-10 shrink-0 items-center gap-1 px-3 pt-1.5"
        style={{ background: "var(--bg)" }}
      >
        <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
          {tabs.map((id) => {
            const isActive = id === activeId;
            return (
              <div
                key={id}
                onClick={() => setActiveId(id)}
                className="group flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg py-1.5 pl-2.5 pr-1.5 text-xs font-medium transition-colors"
                style={{
                  background: isActive ? "var(--bg-elev)" : "transparent",
                  color: isActive ? "var(--text)" : "var(--text-muted)",
                }}
                onMouseEnter={(e) => {
                  if (!isActive) e.currentTarget.style.background = "var(--hover)";
                }}
                onMouseLeave={(e) => {
                  if (!isActive) e.currentTarget.style.background = "transparent";
                }}
              >
                <SquareTerminal size={13} style={{ color: isActive ? "var(--accent)" : "var(--text-muted)" }} />
                <span className="max-w-[140px] truncate">{label}</span>
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(id);
                  }}
                  title="关闭"
                  className="flex h-4 w-4 items-center justify-center rounded opacity-0 transition-opacity hover:bg-[var(--hover)] group-hover:opacity-100"
                >
                  <X size={12} />
                </span>
              </div>
            );
          })}
          <button
            title="新建终端"
            onClick={addTerminal}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors"
            style={{ color: "var(--text-muted)" }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "var(--hover)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            <Plus size={15} />
          </button>
        </div>

        <button
          title="关闭终端面板"
          onClick={toggleBottomPanel}
          className="ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors"
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
          <X size={15} />
        </button>
      </div>

      {/* Terminal surfaces (all mounted; only the active one is visible).
          Left padding aligns the prompt under the tab label. */}
      <div className="relative min-h-0 flex-1 overflow-hidden px-3 pb-2 pt-1" style={{ background: "var(--bg)" }}>
        {tabs.map((id) => (
          <TerminalView key={id} id={id} active={id === activeId} />
        ))}
      </div>
    </div>
  );
}
