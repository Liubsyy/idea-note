import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { dirname, findNode, type FileNode } from "../../lib/fs";
import { useAppStore } from "../../store/useAppStore";

/**
 * Shared selection + drag-to-move controller for the sidebar trees (file mode +
 * notes mode). Dragging is driven by raw mouse events rather than the HTML5
 * Drag API: Tauri's window-level drag-drop (Finder → editor) makes WKWebView
 * swallow `draggable` events inside the page, so native DnD never fires here.
 *
 * Rows opt in by:
 *  - tagging themselves with `data-tree-path={node.path}` (selection order),
 *  - tagging folders with `data-tree-dir={folderPath}` (drop INTO it),
 *  - tagging files with `data-tree-parent={parentDir}` (drop into its folder),
 *  - calling `handleSelectClick(e, path)` first in onClick (⌘/⇧ selection) and
 *    `beginDrag(e, node)` on mousedown,
 *  - highlighting via `overDir` / `draggingPaths`, and guarding onClick with
 *    `shouldIgnoreClick()` so the click after a drag is swallowed.
 */
export interface TreeDrag {
  beginDrag: (e: React.MouseEvent, node: FileNode) => void;
  /** Handle ⌘/Ctrl-click (toggle) and ⇧-click (range). Returns true if it
   *  consumed the click, meaning the caller should NOT open the row. */
  handleSelectClick: (e: React.MouseEvent, path: string) => boolean;
  /** Folder path currently under the drag (a valid drop target), or null. */
  overDir: string | null;
  /** Paths currently being dragged (1 or many), empty when idle. */
  draggingPaths: string[];
  /** True if a drag just ended — used to swallow the click that follows mouseup. */
  shouldIgnoreClick: () => boolean;
}

const TreeDragContext = createContext<TreeDrag | null>(null);

export const useTreeDrag = () => useContext(TreeDragContext);

interface DragItem {
  path: string;
  isDir: boolean;
}

export function TreeDragProvider({
  className,
  style,
  children,
}: {
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}) {
  const workspacePath = useAppStore((s) => s.workspacePath);
  const requestMoveMany = useAppStore((s) => s.requestMoveMany);
  const toggleSelection = useAppStore((s) => s.toggleSelection);
  const selectRange = useAppStore((s) => s.selectRange);

  const [overDir, setOverDir] = useState<string | null>(null);
  const [draggingPaths, setDraggingPaths] = useState<string[]>([]);

  const rootRef = useRef<HTMLDivElement>(null);
  // Live drag state kept in a ref so the window listeners read fresh values.
  const dragRef = useRef<
    { items: DragItem[]; label: string; startX: number; startY: number; active: boolean } | null
  >(null);
  const targetRef = useRef<string | null>(null);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const ignoreClickRef = useRef(false);

  // Visible rows top-to-bottom, for ⇧-click range selection.
  const collectOrder = useCallback(() => {
    const root = rootRef.current;
    if (!root) return [];
    return Array.from(root.querySelectorAll<HTMLElement>("[data-tree-path]"))
      .map((el) => el.getAttribute("data-tree-path"))
      .filter((p): p is string => !!p);
  }, []);

  const handleSelectClick = useCallback(
    (e: React.MouseEvent, path: string) => {
      if (e.metaKey || e.ctrlKey) {
        toggleSelection(path);
        return true;
      }
      if (e.shiftKey) {
        selectRange(path, collectOrder());
        return true;
      }
      return false;
    },
    [toggleSelection, selectRange, collectOrder],
  );

  const beginDrag = useCallback((e: React.MouseEvent, node: FileNode) => {
    if (e.button !== 0) return; // left button only
    if (e.metaKey || e.ctrlKey || e.shiftKey) return; // modifier = selection, not drag
    ignoreClickRef.current = false;

    // Drag the whole multi-selection when grabbing one of its members;
    // otherwise just this row.
    const { selectedPaths, selectedPath, tree } = useAppStore.getState();
    const selection = selectedPaths.length
      ? selectedPaths
      : selectedPath
        ? [selectedPath]
        : [];
    let items: DragItem[];
    if (selection.includes(node.path) && selection.length > 1) {
      items = selection.map((p) => ({ path: p, isDir: findNode(tree, p)?.is_dir ?? false }));
    } else {
      items = [{ path: node.path, isDir: node.is_dir }];
    }
    const label = items.length === 1 ? node.name : `${items.length} 个项目`;
    dragRef.current = { items, label, startX: e.clientX, startY: e.clientY, active: false };
  }, []);

  const shouldIgnoreClick = useCallback(() => {
    if (!ignoreClickRef.current) return false;
    ignoreClickRef.current = false;
    return true;
  }, []);

  useEffect(() => {
    // A drop target is valid unless it's one of the dragged nodes, inside a
    // dragged folder's subtree, or the folder they already all live in.
    const resolveTarget = (dir: string | null, items: DragItem[]): string | null => {
      if (!dir) return null;
      for (const it of items) {
        if (dir === it.path) return null;
        if (it.isDir && dir.startsWith(it.path + "/")) return null;
      }
      if (items.every((it) => dirname(it.path) === dir)) return null;
      return dir;
    };

    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      // Don't treat a tiny jitter as a drag — keeps plain clicks working.
      if (!d.active) {
        if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 5) return;
        d.active = true;
        setDraggingPaths(d.items.map((it) => it.path));
        document.body.style.cursor = "grabbing";
        const g = document.createElement("div");
        g.textContent = d.label;
        g.style.cssText =
          "position:fixed;z-index:9999;pointer-events:none;padding:2px 8px;border-radius:6px;" +
          "font-size:12px;white-space:nowrap;background:var(--bg-elev);color:var(--text);" +
          "border:1px solid var(--border);box-shadow:0 6px 18px var(--shadow);opacity:0.95;";
        document.body.appendChild(g);
        ghostRef.current = g;
      }
      if (ghostRef.current) {
        ghostRef.current.style.left = `${e.clientX + 12}px`;
        ghostRef.current.style.top = `${e.clientY + 12}px`;
      }
      // Resolve the row under the cursor: a folder header drops INTO it; any
      // other row drops into that row's parent folder; empty tree area → root.
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      let dir: string | null = null;
      const folderEl = el?.closest<HTMLElement>("[data-tree-dir]");
      if (folderEl) dir = folderEl.getAttribute("data-tree-dir");
      else {
        const rowEl = el?.closest<HTMLElement>("[data-tree-parent]");
        if (rowEl) dir = rowEl.getAttribute("data-tree-parent");
        else if (rootRef.current && el && rootRef.current.contains(el)) dir = workspacePath;
      }
      const target = resolveTarget(dir, d.items);
      targetRef.current = target;
      setOverDir(target);
    };

    const onUp = () => {
      const d = dragRef.current;
      dragRef.current = null;
      if (ghostRef.current) {
        ghostRef.current.remove();
        ghostRef.current = null;
      }
      if (!d || !d.active) return;
      document.body.style.cursor = "";
      setDraggingPaths([]);
      setOverDir(null);
      ignoreClickRef.current = true; // swallow the click that fires on release
      const target = targetRef.current;
      targetRef.current = null;
      if (target) requestMoveMany(d.items.map((it) => it.path), target);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (ghostRef.current) {
        ghostRef.current.remove();
        ghostRef.current = null;
      }
    };
  }, [workspacePath, requestMoveMany]);

  const rootHighlight = overDir !== null && overDir === workspacePath;

  return (
    <TreeDragContext.Provider
      value={{ beginDrag, handleSelectClick, overDir, draggingPaths, shouldIgnoreClick }}
    >
      <div
        ref={rootRef}
        className={className}
        style={rootHighlight ? { ...style, background: "var(--hover)", borderRadius: 6 } : style}
      >
        {children}
      </div>
    </TreeDragContext.Provider>
  );
}
