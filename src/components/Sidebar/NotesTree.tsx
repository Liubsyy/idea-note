import { useMemo } from "react";
import {
  ChevronRight,
  ChevronDown,
  StickyNote,
  LayoutList,
  ListTree,
} from "lucide-react";
import { isMarkdownFile, dirname, type FileNode } from "../../lib/fs";
import { useAppStore, type NotesViewMode } from "../../store/useAppStore";
import { TreeDragProvider, useTreeDrag } from "./treeDrag";

interface Props {
  nodes: FileNode[];
  onContextMenu: (e: React.MouseEvent, node: FileNode) => void;
}

/** Keep markdown files and folders that (transitively) contain them. */
export function filterNotesTree(nodes: FileNode[]): FileNode[] {
  const result: FileNode[] = [];
  for (const node of nodes) {
    if (node.is_dir) {
      const children = filterNotesTree(node.children ?? []);
      if (children.length) result.push({ ...node, children });
    } else if (isMarkdownFile(node.path)) {
      result.push(node);
    }
  }
  return result;
}

const noteName = (name: string) => name.replace(/\.(md|markdown)$/i, "");

/** Notes in a filtered subtree (every file in it is a markdown note). */
function countNotes(nodes: FileNode[]): number {
  return nodes.reduce(
    (acc, n) => acc + (n.is_dir ? countNotes(n.children ?? []) : 1),
    0,
  );
}

/** "14:32" today, "昨天 14:32", "6月10日" this year, "2024/6/10" before. */
function formatNoteTime(mtime?: number | null): string | null {
  if (!mtime) return null;
  const d = new Date(mtime);
  const now = new Date();
  const dayStart = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayDiff = Math.round((dayStart(now) - dayStart(d)) / 86_400_000);
  const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (dayDiff === 0) return hm;
  if (dayDiff === 1) return `昨天 ${hm}`;
  if (d.getFullYear() === now.getFullYear())
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

interface FoldedFolder {
  node: FileNode;
  label: string;
  paths: string[];
}

function foldSingleFolderChain(node: FileNode): FoldedFolder {
  const names = [node.name];
  const paths = [node.path];
  let current = node;

  while (current.children?.length === 1 && current.children[0].is_dir) {
    current = current.children[0];
    names.push(current.name);
    paths.push(current.path);
  }

  return {
    node: current,
    label: names.join(" / "),
    paths,
  };
}

/**
 * Sidebar notes mode: only markdown notes, shown without their extension.
 * Two layouts, toggled by the small switcher in its header row:
 *  - "cards": Bear-style note cards (title + excerpt + time) sorted by
 *    modification time, folders as collapsible group headings;
 *  - "tree": the folder hierarchy, each note as a two-line row.
 */
export function NotesTree({ nodes, onContextMenu }: Props) {
  const filtered = useMemo(() => filterNotesTree(nodes), [nodes]);
  const view = useAppStore((s) => s.notesViewMode);
  const setView = useAppStore((s) => s.setNotesViewMode);
  const total = useMemo(() => countNotes(filtered), [filtered]);

  if (!filtered.length) {
    return (
      <p className="px-4 py-6 text-center text-xs" style={{ color: "var(--text-muted)" }}>
        这个文件夹里还没有 Markdown 笔记。
      </p>
    );
  }

  return (
    <div>
      {/* Sub-mode header: note count + cards/tree switcher */}
      <div className="flex items-center justify-between px-2.5 pb-1.5 pt-0.5 select-none">
        <span style={{ fontSize: "max(0.8em, 11px)", color: "var(--text-muted)" }}>
          {total} 篇笔记
        </span>
        <div
          className="flex items-center overflow-hidden rounded-md"
          style={{ border: "1px solid var(--border)", background: "var(--bg)" }}
        >
          <ViewButton
            mode="cards"
            active={view === "cards"}
            title="卡片视图"
            onSelect={setView}
          >
            <LayoutList size={12} />
          </ViewButton>
          <ViewButton
            mode="tree"
            active={view === "tree"}
            title="树形视图"
            onSelect={setView}
            withDivider
          >
            <ListTree size={12} />
          </ViewButton>
        </div>
      </div>
      <TreeDragProvider>
        {view === "cards" ? (
          <CardList nodes={filtered} depth={0} onContextMenu={onContextMenu} />
        ) : (
          <NoteList nodes={filtered} depth={0} onContextMenu={onContextMenu} />
        )}
      </TreeDragProvider>
    </div>
  );
}

function ViewButton({
  mode,
  active,
  title,
  withDivider,
  onSelect,
  children,
}: {
  mode: NotesViewMode;
  active: boolean;
  title: string;
  withDivider?: boolean;
  onSelect: (mode: NotesViewMode) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      onClick={() => onSelect(mode)}
      className="flex h-[20px] w-7 items-center justify-center transition-colors"
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

/* ---------------------------------- cards ---------------------------------- */

function CardList({
  nodes,
  depth,
  onContextMenu,
}: {
  nodes: FileNode[];
  depth: number;
  onContextMenu: Props["onContextMenu"];
}) {
  // Same order as the file tree: folders first, then files, alphabetically.
  return (
    <div
      className={`space-y-1.5 ${depth === 0 ? "px-2" : ""}`}
      style={{ paddingLeft: depth ? 10 : undefined }}
    >
      {nodes.map((n) =>
        n.is_dir ? (
          <CardGroup key={n.path} node={n} depth={depth} onContextMenu={onContextMenu} />
        ) : (
          <NoteCard key={n.path} node={n} onContextMenu={onContextMenu} />
        ),
      )}
    </div>
  );
}

function CardGroup({
  node,
  depth,
  onContextMenu,
}: {
  node: FileNode;
  depth: number;
  onContextMenu: Props["onContextMenu"];
}) {
  const folded = foldSingleFolderChain(node);
  const folderNode = folded.node;
  const selectedPath = useAppStore((s) => s.selectedPath);
  const selectedPaths = useAppStore((s) => s.selectedPaths);
  const openFolder = useAppStore((s) => s.openFolder);
  const compactSidebar = useAppStore((s) => s.compactSidebar);
  const drag = useTreeDrag();
  const storedOpen = useAppStore((s) => s.expanded[folderNode.path]);
  const setExpanded = useAppStore((s) => s.setExpanded);
  const open = storedOpen ?? depth < 1;
  const isActive = selectedPaths.length
    ? folded.paths.some((p) => selectedPaths.includes(p))
    : selectedPath
      ? folded.paths.includes(selectedPath)
      : false;
  // Notes drop into the deepest folder of the folded chain; dragging moves the
  // whole chain (its top node).
  const isDropTarget = drag?.overDir === folderNode.path;
  const isDragging = drag?.draggingPaths.includes(node.path) ?? false;

  return (
    <div>
      <div
        data-tree-path={node.path}
        data-tree-dir={folderNode.path}
        onMouseDown={(e) => drag?.beginDrag(e, node)}
        onClick={(e) => {
          if (drag?.shouldIgnoreClick()) return;
          if (drag?.handleSelectClick(e, node.path)) return;
          openFolder(folderNode);
        }}
        onContextMenu={(e) => onContextMenu(e, folderNode)}
        className={`flex cursor-pointer select-none items-center gap-1 rounded-md pr-2 transition-colors ${
          compactSidebar ? "py-0.5" : "py-1"
        }`}
        style={{
          paddingLeft: 4,
          opacity: isDragging ? 0.5 : 1,
          background: isDropTarget
            ? "color-mix(in srgb, var(--accent) 18%, transparent)"
            : isActive
              ? "var(--active)"
              : "transparent",
          boxShadow: isDropTarget ? "inset 0 0 0 1px var(--accent)" : undefined,
          color: isActive ? "var(--accent)" : "var(--tree-text)",
        }}
        onMouseEnter={(e) => {
          if (!isActive && !isDropTarget) e.currentTarget.style.background = "var(--hover)";
        }}
        onMouseLeave={(e) => {
          if (!isActive && !isDropTarget) e.currentTarget.style.background = "transparent";
        }}
      >
        {/* Only the chevron toggles expand/collapse, matching the tree view. */}
        <span
          onClick={(e) => {
            e.stopPropagation();
            setExpanded(folderNode.path, !open);
          }}
          className="flex h-4 w-4 shrink-0 items-center justify-center"
          title={open ? "收起" : "展开"}
        >
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </span>
        <span className="truncate" title={folded.label}>
          {folded.label}
        </span>
      </div>
      {open && folderNode.children && (
        <div className="pt-1.5">
          <CardList
            nodes={folderNode.children}
            depth={depth + 1}
            onContextMenu={onContextMenu}
          />
        </div>
      )}
    </div>
  );
}

function NoteCard({
  node,
  onContextMenu,
}: {
  node: FileNode;
  onContextMenu: Props["onContextMenu"];
}) {
  const selectedPath = useAppStore((s) => s.selectedPath);
  const selectedPaths = useAppStore((s) => s.selectedPaths);
  const openFile = useAppStore((s) => s.openFile);
  const drag = useTreeDrag();
  const isActive = selectedPaths.length
    ? selectedPaths.includes(node.path)
    : selectedPath === node.path;
  const isDragging = drag?.draggingPaths.includes(node.path) ?? false;
  const time = formatNoteTime(node.mtime);

  return (
    <div
      data-tree-path={node.path}
      data-tree-parent={dirname(node.path)}
      onMouseDown={(e) => drag?.beginDrag(e, node)}
      onClick={(e) => {
        if (drag?.shouldIgnoreClick()) return;
        if (drag?.handleSelectClick(e, node.path)) return;
        openFile(node.path);
      }}
      onContextMenu={(e) => onContextMenu(e, node)}
      className="cursor-pointer rounded-lg px-2.5 py-2 transition-colors"
      style={{
        opacity: isDragging ? 0.5 : 1,
        background: isActive ? "var(--active)" : "var(--bg)",
        border: `1px solid ${isActive ? "var(--accent)" : "var(--card-border)"}`,
      }}
      onMouseEnter={(e) => {
        if (!isActive) e.currentTarget.style.background = "var(--hover)";
      }}
      onMouseLeave={(e) => {
        if (!isActive) e.currentTarget.style.background = "var(--bg)";
      }}
    >
      <div
        className="truncate font-medium"
        style={{ color: isActive ? "var(--accent)" : "var(--tree-text)" }}
      >
        {noteName(node.name)}
      </div>
      {node.excerpt && (
        <div
          className="truncate"
          style={{
            fontSize: "max(0.84em, 11px)",
            color: "var(--text-soft)",
            marginTop: 2,
          }}
        >
          {node.excerpt}
        </div>
      )}
      {time && (
        <div
          style={{
            fontSize: "max(0.8em, 11px)",
            color: "var(--text-muted)",
            marginTop: 3,
          }}
        >
          {time}
        </div>
      )}
    </div>
  );
}

/* ----------------------------------- tree ---------------------------------- */

function NoteList({
  nodes,
  depth,
  onContextMenu,
}: {
  nodes: FileNode[];
  depth: number;
  onContextMenu: Props["onContextMenu"];
}) {
  return (
    <div className="space-y-px px-1.5">
      {nodes.map((node) =>
        node.is_dir ? (
          <FolderRow key={node.path} node={node} depth={depth} onContextMenu={onContextMenu} />
        ) : (
          <NoteRow key={node.path} node={node} depth={depth} onContextMenu={onContextMenu} />
        ),
      )}
    </div>
  );
}

function FolderRow({
  node,
  depth,
  onContextMenu,
}: {
  node: FileNode;
  depth: number;
  onContextMenu: Props["onContextMenu"];
}) {
  const folded = foldSingleFolderChain(node);
  const folderNode = folded.node;
  const selectedPath = useAppStore((s) => s.selectedPath);
  const selectedPaths = useAppStore((s) => s.selectedPaths);
  const openFolder = useAppStore((s) => s.openFolder);
  const compactSidebar = useAppStore((s) => s.compactSidebar);
  const drag = useTreeDrag();
  // Shared with the file tree: expand state persists in the store by path.
  const storedOpen = useAppStore((s) => s.expanded[folderNode.path]);
  const setExpanded = useAppStore((s) => s.setExpanded);
  const open = storedOpen ?? depth < 1;
  const isActive = selectedPaths.length
    ? folded.paths.some((p) => selectedPaths.includes(p))
    : selectedPath
      ? folded.paths.includes(selectedPath)
      : false;
  const isDropTarget = drag?.overDir === folderNode.path;
  const isDragging = drag?.draggingPaths.includes(node.path) ?? false;

  return (
    <div>
      <div
        data-tree-path={node.path}
        data-tree-dir={folderNode.path}
        onMouseDown={(e) => drag?.beginDrag(e, node)}
        onClick={(e) => {
          if (drag?.shouldIgnoreClick()) return;
          if (drag?.handleSelectClick(e, node.path)) return;
          openFolder(folderNode);
        }}
        onContextMenu={(e) => onContextMenu(e, folderNode)}
        className={`flex cursor-pointer select-none items-center gap-1 rounded-md pr-2 transition-colors ${
          compactSidebar ? "py-0.5" : "py-1"
        }`}
        style={{
          paddingLeft: 4 + depth * 14,
          opacity: isDragging ? 0.5 : 1,
          background: isDropTarget
            ? "color-mix(in srgb, var(--accent) 18%, transparent)"
            : isActive
              ? "var(--active)"
              : "transparent",
          boxShadow: isDropTarget ? "inset 0 0 0 1px var(--accent)" : undefined,
          color: isActive ? "var(--accent)" : "var(--tree-text)",
        }}
        onMouseEnter={(e) => {
          if (!isActive && !isDropTarget) e.currentTarget.style.background = "var(--hover)";
        }}
        onMouseLeave={(e) => {
          if (!isActive && !isDropTarget) e.currentTarget.style.background = "transparent";
        }}
      >
        {/* Only the chevron toggles expand/collapse, matching the file tree. */}
        <span
          onClick={(e) => {
            e.stopPropagation();
            setExpanded(folderNode.path, !open);
          }}
          className="flex h-4 w-4 shrink-0 items-center justify-center"
          title={open ? "收起" : "展开"}
        >
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </span>
        <span className="truncate" title={folded.label}>
          {folded.label}
        </span>
      </div>
      {open && folderNode.children && (
        <NoteList nodes={folderNode.children} depth={depth + 1} onContextMenu={onContextMenu} />
      )}
    </div>
  );
}

function NoteRow({
  node,
  depth,
  onContextMenu,
}: {
  node: FileNode;
  depth: number;
  onContextMenu: Props["onContextMenu"];
}) {
  const selectedPath = useAppStore((s) => s.selectedPath);
  const selectedPaths = useAppStore((s) => s.selectedPaths);
  const openFile = useAppStore((s) => s.openFile);
  const compactSidebar = useAppStore((s) => s.compactSidebar);
  const drag = useTreeDrag();
  const isActive = selectedPaths.length
    ? selectedPaths.includes(node.path)
    : selectedPath === node.path;
  const isDragging = drag?.draggingPaths.includes(node.path) ?? false;
  const time = formatNoteTime(node.mtime);

  return (
    <div
      data-tree-path={node.path}
      data-tree-parent={dirname(node.path)}
      onMouseDown={(e) => drag?.beginDrag(e, node)}
      onClick={(e) => {
        if (drag?.shouldIgnoreClick()) return;
        if (drag?.handleSelectClick(e, node.path)) return;
        openFile(node.path);
      }}
      onContextMenu={(e) => onContextMenu(e, node)}
      className={`flex cursor-pointer items-start gap-1.5 rounded-md pr-2 transition-colors ${
        compactSidebar ? "py-0.5" : "py-1"
      }`}
      style={{
        paddingLeft: 8 + depth * 14,
        opacity: isDragging ? 0.5 : 1,
        background: isActive ? "var(--active)" : "transparent",
        color: isActive ? "var(--accent)" : "var(--tree-text)",
      }}
      onMouseEnter={(e) => {
        if (!isActive) e.currentTarget.style.background = "var(--hover)";
      }}
      onMouseLeave={(e) => {
        if (!isActive) e.currentTarget.style.background = "transparent";
      }}
    >
      <span
        className="flex shrink-0 justify-center"
        style={{
          width: "1.35em",
          paddingTop: compactSidebar ? "0.16em" : "0.22em",
        }}
      >
        <StickyNote
          size="1.05em"
          style={{ color: isActive ? "var(--accent)" : "var(--note-icon)" }}
        />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate" style={{ lineHeight: 1.25 }}>
          {noteName(node.name)}
        </div>
        {(node.excerpt || time) && (
          <div
            className="truncate"
            style={{ fontSize: "max(0.82em, 11px)", lineHeight: 1.25, marginTop: 2 }}
          >
            {node.excerpt && (
              <span style={{ color: "var(--text-soft)" }}>{node.excerpt}</span>
            )}
            {node.excerpt && time && (
              <span style={{ color: "var(--text-muted)" }}> · </span>
            )}
            {time && <span style={{ color: "var(--text-muted)" }}>{time}</span>}
          </div>
        )}
      </div>
    </div>
  );
}
