import { memo, useEffect, useMemo, useRef, useState } from "react";
import { EditorView } from "@codemirror/view";
import { EditorSelection } from "@codemirror/state";
import {
  CaseSensitive,
  ChevronDown,
  ChevronRight,
  FileText,
  Regex,
  Search,
  WholeWord,
  X,
} from "lucide-react";
import { useAppStore } from "../../store/useAppStore";
import { dirname } from "../../lib/fs";
import { relativePath } from "../../lib/clipboard";
import { getActiveView } from "../../lib/codemirror/activeView";
import type { GlobalSearchHit } from "../../lib/search";

const DEBOUNCE_MS = 300;
/** How long to wait for the editor remount after opening a hit's file. */
const VIEW_WAIT_TIMEOUT_MS = 1500;

/**
 * Sidebar search mode: workspace-wide keyword search (filenames + content).
 * Query and results live in the store so they survive mode switches; this
 * component only debounces input and renders/jumps.
 */
export function SearchPanel() {
  const workspacePath = useAppStore((s) => s.workspacePath);
  const query = useAppStore((s) => s.searchQuery);
  const setSearchQuery = useAppStore((s) => s.setSearchQuery);
  const runGlobalSearch = useAppStore((s) => s.runGlobalSearch);
  const options = useAppStore((s) => s.searchOptions);
  const toggleSearchOption = useAppStore((s) => s.toggleSearchOption);
  const stopGlobalSearch = useAppStore((s) => s.stopGlobalSearch);
  const hits = useAppStore((s) => s.searchHits);
  const totalHits = useAppStore((s) => s.searchTotalHits);
  const displayLimited = useAppStore((s) => s.searchDisplayLimited);
  const truncated = useAppStore((s) => s.searchTruncated);
  const loading = useAppStore((s) => s.searchLoading);
  const regexError = useAppStore((s) => s.searchRegexError);
  const focusKey = useAppStore((s) => s.searchFocusKey);

  const inputRef = useRef<HTMLInputElement>(null);

  // Focus on mount and whenever ⌘⇧F bumps the key.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusKey]);

  useEffect(() => {
    const t = window.setTimeout(() => void runGlobalSearch(query), DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [query, runGlobalSearch]);

  const trimmedQuery = query.trim();

  // Counts for the status line only. Recomputes when hits change (i.e. as
  // results stream in), not on every keystroke — query isn't a dependency.
  const { resultCount, fileCount } = useMemo(
    () => ({
      resultCount: totalHits || hits.length,
      fileCount: new Set(hits.map((h) => h.path)).size,
    }),
    [hits, totalHits],
  );
  const displayLimitText =
    displayLimited && hits.length > 0 ? ` · 显示前 ${hits.length} 条` : "";

  return (
    <div onContextMenu={(e) => e.stopPropagation()}>
      {/* Query input */}
      <div className="px-2 pb-1 pt-1.5">
        <div
          className="flex items-center gap-1.5 rounded-md px-2"
          style={{ border: "1px solid var(--border)", background: "var(--bg)" }}
        >
          <Search size={13} className="shrink-0" style={{ color: "var(--text-muted)" }} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setSearchQuery(e.target.value)}
            // Keep keys away from the list container's ⌘C/⌘V file handlers.
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") e.currentTarget.blur();
            }}
            placeholder="搜索全部笔记"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent py-1 text-sm outline-none"
            style={{ color: "var(--text)" }}
          />
          {query && (
            <button
              title="清空"
              onClick={() => setSearchQuery("")}
              className="shrink-0 rounded p-0.5 transition-colors"
              style={{ color: "var(--text-muted)" }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text)")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-muted)")}
            >
              <X size={12} />
            </button>
          )}
          <div className="flex shrink-0 items-center gap-0.5">
            <OptionToggle
              active={options.caseSensitive}
              title="区分大小写"
              onClick={() => toggleSearchOption("caseSensitive")}
            >
              <CaseSensitive size={15} />
            </OptionToggle>
            <OptionToggle
              active={options.wholeWord}
              title="全词匹配"
              onClick={() => toggleSearchOption("wholeWord")}
            >
              <WholeWord size={15} />
            </OptionToggle>
            <OptionToggle
              active={options.regex}
              title="正则表达式"
              onClick={() => toggleSearchOption("regex")}
            >
              <Regex size={14} />
            </OptionToggle>
          </div>
          {loading && (
            <button
              title="停止搜索"
              onClick={stopGlobalSearch}
              className="shrink-0 rounded px-1.5 py-0.5 text-xs transition-colors"
              style={{ color: "var(--accent)", background: "var(--active)" }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--hover)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "var(--active)")}
            >
              停止
            </button>
          )}
        </div>
        {trimmedQuery && (
          <p
            className="px-1 pt-1 text-xs"
            style={{ color: regexError ? "#e5484d" : "var(--text-muted)" }}
          >
            {regexError
              ? `正则表达式无效：${regexError}`
              : resultCount
                ? `${resultCount} 个结果 · ${fileCount} 个文件${
                    loading ? " · 搜索中…" : truncated ? " · 已停止" : ""
                  }${displayLimitText}`
                : displayLimited
                  ? `结果很多，已显示前 ${hits.length} 条${
                      loading ? " · 搜索中…" : truncated ? " · 已停止" : ""
                  }`
                : loading
                  ? "搜索中…"
                  : truncated
                    ? "搜索已停止"
                  : "没有匹配结果"}
          </p>
        )}
        {trimmedQuery && loading && (
          <div className="search-loading-bar mx-1 mt-1" aria-hidden />
        )}
      </div>

      {!workspacePath ? (
        <Empty>未打开工作区。</Empty>
      ) : !trimmedQuery ? (
        <Empty>输入关键词，搜索文件名和笔记内容。</Empty>
      ) : (
        // Memoized: keystrokes re-render this panel (input + status line) but
        // not the (potentially large) result list, since SearchResults takes
        // no props and reads hits straight from the store.
        <SearchResults />
      )}
    </div>
  );
}

/**
 * The result list. Subscribes to the store directly and is wrapped in
 * `memo` so it re-renders only when results (or its own row state) change —
 * insulating the list from the input box's per-keystroke re-renders.
 */
const SearchResults = memo(function SearchResults() {
  const workspacePath = useAppStore((s) => s.workspacePath);
  const hits = useAppStore((s) => s.searchHits);
  const truncated = useAppStore((s) => s.searchTruncated);
  const displayLimited = useAppStore((s) => s.searchDisplayLimited);
  const compactSidebar = useAppStore((s) => s.compactSidebar);
  const openFile = useAppStore((s) => s.openFile);

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  /** `${path}:${line}` of the last clicked hit (row highlight). */
  const [activeHit, setActiveHit] = useState<string | null>(null);

  const { nameHits, fileGroups } = useMemo(() => {
    const nameHits: GlobalSearchHit[] = [];
    const groups = new Map<string, GlobalSearchHit[]>();
    for (const hit of hits) {
      if (hit.line == null) {
        nameHits.push(hit);
      } else {
        const list = groups.get(hit.path);
        if (list) list.push(hit);
        else groups.set(hit.path, [hit]);
      }
    }
    return { nameHits, fileGroups: [...groups.entries()] };
  }, [hits]);

  const jumpTo = async (hit: GlobalSearchHit) => {
    setActiveHit(`${hit.path}:${hit.line ?? ""}`);
    const prevView = getActiveView();
    const prevDocKey = useAppStore.getState().docKey;
    await openFile(hit.path);
    if (hit.line == null) return;
    // openFile bumps docKey only on success (binaries alert and bail).
    if (useAppStore.getState().docKey === prevDocKey) return;
    const view = await waitForNewView(prevView);
    if (!view) return;

    const lineNo = Math.min(hit.line, view.state.doc.lines);
    const docLine = view.state.doc.line(lineNo);
    // Re-locate the exact matched substring in the live document — robust
    // against the saved file drifting from what the scan saw, and correct for
    // every mode (the matched text is literal, whatever produced it).
    const matched = hit.matched_text;
    const idx = matched ? docLine.text.indexOf(matched) : -1;
    const from = idx >= 0 ? docLine.from + idx : docLine.from;
    const to = idx >= 0 ? from + matched.length : docLine.from;
    // Unlike the outline's scroll-only jump, search selects the match: the
    // view is explicitly focused, so live preview reveals the line's source
    // the same way a manual click there would.
    view.focus();
    view.dispatch({
      selection: EditorSelection.range(from, to),
      effects: EditorView.scrollIntoView(from, { y: "center" }),
    });
  };

  const rowPad = compactSidebar ? "py-0.5" : "py-1";

  return (
    <div className="pb-2">
      {nameHits.length > 0 && (
        <>
          <SectionLabel>文件名匹配</SectionLabel>
          {nameHits.map((hit) => (
            <button
              key={hit.path}
              title={hit.path}
              onClick={() => void jumpTo(hit)}
              className={`flex w-full items-center gap-1.5 px-3 text-left ${rowPad} transition-colors`}
              style={{
                color: "var(--tree-text)",
                background:
                  activeHit === `${hit.path}:` ? "var(--active)" : "transparent",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--hover)")}
              onMouseLeave={(e) =>
                (e.currentTarget.style.background =
                  activeHit === `${hit.path}:` ? "var(--active)" : "transparent")
              }
            >
              <FileText size={13} className="shrink-0" style={{ color: "var(--tree-icon)" }} />
              <span className="truncate">
                <Highlighted text={hit.name} start={hit.match_start} len={hit.match_len} />
              </span>
            </button>
          ))}
        </>
      )}

      {fileGroups.length > 0 && nameHits.length > 0 && (
        <SectionLabel>内容匹配</SectionLabel>
      )}
      {fileGroups.map(([path, fileHits]) => {
        const isCollapsed = !!collapsed[path];
        const relDir = relativePath(dirname(path), workspacePath ?? "");
        return (
          <div key={path}>
            <button
              title={path}
              onClick={() => setCollapsed((c) => ({ ...c, [path]: !isCollapsed }))}
              className={`flex w-full items-center gap-1 px-2 text-left ${rowPad} transition-colors`}
              style={{ color: "var(--tree-text)" }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--hover)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              {isCollapsed ? (
                <ChevronRight size={13} className="shrink-0" style={{ color: "var(--text-muted)" }} />
              ) : (
                <ChevronDown size={13} className="shrink-0" style={{ color: "var(--text-muted)" }} />
              )}
              <span className="truncate font-medium">{fileHits[0].name}</span>
              {relDir !== "." && (
                <span className="min-w-0 truncate text-xs" style={{ color: "var(--text-muted)" }}>
                  {relDir}
                </span>
              )}
              <span
                className="ml-auto shrink-0 rounded-full px-1.5 text-xs"
                style={{ background: "var(--hover)", color: "var(--text-soft)" }}
              >
                {fileHits.length}
              </span>
            </button>
            {!isCollapsed &&
              fileHits.map((hit) => {
                const hitKey = `${hit.path}:${hit.line}`;
                return (
                  <button
                    key={hitKey}
                    onClick={() => void jumpTo(hit)}
                    className={`flex w-full items-baseline gap-1.5 pl-7 pr-2 text-left ${rowPad} transition-colors`}
                    style={{
                      background: activeHit === hitKey ? "var(--active)" : "transparent",
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "var(--hover)")}
                    onMouseLeave={(e) =>
                      (e.currentTarget.style.background =
                        activeHit === hitKey ? "var(--active)" : "transparent")
                    }
                  >
                    <span
                      className="w-6 shrink-0 text-right text-xs tabular-nums"
                      style={{ color: "var(--text-muted)" }}
                    >
                      {hit.line}
                    </span>
                    <span className="truncate" style={{ color: "var(--text-soft)" }}>
                      <Highlighted
                        text={hit.snippet ?? ""}
                        start={hit.match_start}
                        len={hit.match_len}
                      />
                    </span>
                  </button>
                );
              })}
          </div>
        );
      })}

      {truncated && (
        <p className="px-3 pt-2 text-center text-xs" style={{ color: "var(--text-muted)" }}>
          搜索已停止，结果可能不完整。
        </p>
      )}
      {displayLimited && !truncated && (
        <p className="px-3 pt-2 text-center text-xs" style={{ color: "var(--text-muted)" }}>
          结果很多，仅显示前 {hits.length} 条；可点击停止结束搜索。
        </p>
      )}
    </div>
  );
});

/** Wait for the editor remount triggered by openFile (App keys it on docKey). */
function waitForNewView(prevView: EditorView | null): Promise<EditorView | null> {
  return new Promise((resolve) => {
    const deadline = Date.now() + VIEW_WAIT_TIMEOUT_MS;
    const tick = () => {
      const view = getActiveView();
      if (view && view !== prevView) return resolve(view);
      if (Date.now() > deadline) return resolve(null);
      requestAnimationFrame(tick);
    };
    tick();
  });
}

const markStyle: React.CSSProperties = {
  background: "var(--search-mark)",
  color: "inherit",
  borderRadius: 2,
  padding: "0 1px",
};

/** `text` with the backend-reported `[start, start+len)` char range marked.
 *  Offsets are Unicode code points, so split via Array.from rather than slice
 *  (a regex match can span surrogate-pair characters). */
function Highlighted({ text, start, len }: { text: string; start: number; len: number }) {
  if (len <= 0) return <>{text}</>;
  const chars = Array.from(text);
  return (
    <>
      {chars.slice(0, start).join("")}
      <mark style={markStyle}>{chars.slice(start, start + len).join("")}</mark>
      {chars.slice(start + len).join("")}
    </>
  );
}

/** One of the case/word/regex toggles in the search input. */
function OptionToggle({
  active,
  title,
  onClick,
  children,
}: {
  active: boolean;
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      aria-pressed={active}
      onClick={onClick}
      className="flex h-5 w-4 shrink-0 items-center justify-center rounded transition-colors"
      style={{
        color: active ? "var(--accent)" : "var(--text-muted)",
        background: active ? "var(--active)" : "transparent",
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

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="px-3 pb-0.5 pt-2 text-xs font-medium"
      style={{ color: "var(--text-muted)" }}
    >
      {children}
    </p>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-4 py-6 text-center text-xs" style={{ color: "var(--text-muted)" }}>
      {children}
    </p>
  );
}
