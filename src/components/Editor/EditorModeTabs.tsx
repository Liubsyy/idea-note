import { PenLine, Code2, BookOpen } from "lucide-react";
import { useAppStore, type MdViewMode } from "../../store/useAppStore";

/**
 * Markdown editor view-mode switch in the header. A compact segmented control:
 * a subtle track holds three icon buttons; the active mode reads as a light
 * "raised" segment (elevated fill + soft shadow + accent icon) rather than a
 * heavy solid block. Drives the store's mdViewMode, which the CodeMirror
 * surface watches to swap the rendering / read-only extensions in place.
 */
export function EditorModeTabs() {
  const mdViewMode = useAppStore((s) => s.mdViewMode);
  const setMdViewMode = useAppStore((s) => s.setMdViewMode);

  const btn = (mode: MdViewMode, label: string, icon: React.ReactNode) => {
    const active = mdViewMode === mode;
    return (
      <button
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setMdViewMode(mode)}
        title={label}
        className="flex h-[22px] w-[22px] items-center justify-center rounded-[5px] transition-all duration-150"
        style={{
          color: active ? "var(--accent)" : "var(--text-muted)",
          background: active ? "var(--bg)" : "transparent",
          boxShadow: active ? "0 1px 2px var(--shadow)" : "none",
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
        {icon}
      </button>
    );
  };

  return (
    <div
      className="inline-flex items-center gap-[2px] rounded-[7px] p-[2px]"
      style={{
        background: "var(--bg-elev)",
        border: "1px solid var(--border)",
      }}
    >
      {btn("live", "编辑", <PenLine size={13} strokeWidth={1.75} />)}
      {btn("readonly", "只读", <BookOpen size={13} strokeWidth={1.75} />)}
      {btn("source", "源码", <Code2 size={13} strokeWidth={1.75} />)}
    </div>
  );
}
