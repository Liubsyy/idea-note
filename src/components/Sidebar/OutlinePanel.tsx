import { useMemo } from "react";
import { EditorView } from "@codemirror/view";
import { useAppStore } from "../../store/useAppStore";
import { isMarkdownFile } from "../../lib/fs";
import { extractOutline, type OutlineItem } from "../../lib/outline";
import { getActiveView } from "../../lib/codemirror/activeView";

/**
 * Sidebar outline mode: heading table-of-contents of the open markdown file.
 * Parses the live store content, so it updates as the user types.
 */
export function OutlinePanel() {
  const activeFilePath = useAppStore((s) => s.activeFilePath);
  const content = useAppStore((s) => s.content);
  const compactSidebar = useAppStore((s) => s.compactSidebar);

  const isMd = !!activeFilePath && isMarkdownFile(activeFilePath);
  const items = useMemo(
    () => (isMd ? extractOutline(content) : []),
    [isMd, content],
  );

  if (!activeFilePath) return <Empty>未打开笔记。</Empty>;
  if (!isMd) return <Empty>当前文件不是 Markdown。</Empty>;
  if (!items.length) return <Empty>此笔记还没有标题。</Empty>;

  const jumpTo = (item: OutlineItem) => {
    const view = getActiveView();
    if (!view) return;
    // The store content mirrors the editor doc, but clamp in case of a race.
    const lineNo = Math.min(item.line + 1, view.state.doc.lines);
    const pos = view.state.doc.line(lineNo).from;
    // Scroll only — never move the caret or focus. Live preview reveals the
    // focused cursor line, so a programmatic caret would either expand the
    // heading to source (focused) or leave a hidden DOM caret that WebKit
    // scroll-restores on the next click, landing the click one line off
    // (blurred). Leaving selection alone keeps manual clicks pixel-accurate.
    view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: "start" }) });
  };

  return (
    <div className="py-1">
      {items.map((item, i) => (
        <button
          key={`${item.line}-${i}`}
          onClick={() => jumpTo(item)}
          title={item.text}
          className={`block w-full truncate pr-2 text-left transition-colors ${
            compactSidebar ? "py-0.5" : "py-1"
          }`}
          style={{
            paddingLeft: 12 + (item.level - 1) * 14,
            color: item.level === 1 ? "var(--tree-text)" : "var(--text-soft)",
            fontWeight: item.level === 1 ? 600 : item.level === 2 ? 500 : 400,
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "var(--hover)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          {item.text}
        </button>
      ))}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-4 py-6 text-center text-xs" style={{ color: "var(--text-muted)" }}>
      {children}
    </p>
  );
}
