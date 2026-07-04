import {
  ChevronRight,
  ChevronDown,
  Braces,
  FileCode,
  FileText,
  Folder,
  FolderOpen,
  Image,
  StickyNote,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { isMarkdownFile, dirname, type FileNode } from "../../lib/fs";
import { useAppStore } from "../../store/useAppStore";
import { TreeDragProvider, useTreeDrag } from "./treeDrag";

interface Props {
  nodes: FileNode[];
  depth?: number;
  onContextMenu: (e: React.MouseEvent, node: FileNode) => void;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|svg|webp|bmp|ico|avif|heic)$/i;
const CODE_EXT =
  /\.(ts|tsx|js|jsx|mjs|cjs|rs|py|go|java|c|h|cpp|hpp|cs|rb|php|swift|kt|sh|zsh|bash|sql|html|css|scss|less|vue|lua)$/i;
const CONFIG_EXT =
  /\.(json|jsonc|ya?ml|toml|ini|conf|cfg|xml|plist|properties|lock|env)$/i;

/** Per-type icon + low-saturation color (markdown reuses the notes amber). */
function fileVisual(name: string): { Icon: LucideIcon; color: string } {
  if (isMarkdownFile(name)) return { Icon: StickyNote, color: "var(--note-icon)" };
  if (IMAGE_EXT.test(name)) return { Icon: Image, color: "var(--file-image)" };
  if (CODE_EXT.test(name)) return { Icon: FileCode, color: "var(--file-code)" };
  if (CONFIG_EXT.test(name)) return { Icon: Braces, color: "var(--file-config)" };
  return { Icon: FileText, color: "var(--tree-icon)" };
}

function Rows({ nodes, depth, onContextMenu }: Required<Pick<Props, "nodes" | "depth">> & {
  onContextMenu: Props["onContextMenu"];
}) {
  return (
    <>
      {nodes.map((node) => (
        <TreeRow key={node.path} node={node} depth={depth} onContextMenu={onContextMenu} />
      ))}
    </>
  );
}

export function FileTree({ nodes, onContextMenu }: Props) {
  return (
    <TreeDragProvider className="px-1.5">
      <Rows nodes={nodes} depth={0} onContextMenu={onContextMenu} />
    </TreeDragProvider>
  );
}

function TreeRow({
  node,
  depth,
  onContextMenu,
}: {
  node: FileNode;
  depth: number;
  onContextMenu: (e: React.MouseEvent, node: FileNode) => void;
}) {
  const selectedPath = useAppStore((s) => s.selectedPath);
  const selectedPaths = useAppStore((s) => s.selectedPaths);
  const openFile = useAppStore((s) => s.openFile);
  const openFolder = useAppStore((s) => s.openFolder);
  const compactSidebar = useAppStore((s) => s.compactSidebar);
  const drag = useTreeDrag();
  // Expand state lives in the store (keyed by path) so it persists across
  // sidebar-mode switches; default to "top level open" when never toggled.
  const storedOpen = useAppStore((s) => s.expanded[node.path]);
  const setExpanded = useAppStore((s) => s.setExpanded);
  const open = storedOpen ?? depth < 1;

  // The multi-selection set takes over highlighting once it's non-empty.
  const isActive = selectedPaths.length
    ? selectedPaths.includes(node.path)
    : selectedPath === node.path;
  // Dotfiles (just made visible in the tree) read as secondary.
  const hidden = node.name.startsWith(".");
  const isDropTarget = drag?.overDir === node.path;
  const isDragging = drag?.draggingPaths.includes(node.path) ?? false;

  if (node.is_dir) {
    return (
      <div>
        <div
          data-tree-path={node.path}
          data-tree-dir={node.path}
          onMouseDown={(e) => drag?.beginDrag(e, node)}
          onClick={(e) => {
            if (drag?.shouldIgnoreClick()) return;
            if (drag?.handleSelectClick(e, node.path)) return;
            openFolder(node);
          }}
          onContextMenu={(e) => onContextMenu(e, node)}
          className={`flex cursor-pointer items-center gap-1 rounded-md pr-2 transition-colors ${
            compactSidebar ? "py-0.5" : "py-1"
          }`}
          style={{
            paddingLeft: 4,
            opacity: isDragging ? 0.5 : 1,
            // Drop-target highlight wins over the active/idle background.
            background: isDropTarget
              ? "color-mix(in srgb, var(--accent) 18%, transparent)"
              : isActive
                ? "var(--active)"
                : "transparent",
            boxShadow: isDropTarget ? "inset 0 0 0 1px var(--accent)" : undefined,
            color: isActive
              ? "var(--accent)"
              : hidden
                ? "var(--text-muted)"
                : "var(--tree-text)",
          }}
          onMouseEnter={(e) => {
            if (!isActive && !isDropTarget) e.currentTarget.style.background = "var(--hover)";
          }}
          onMouseLeave={(e) => {
            if (!isActive && !isDropTarget) e.currentTarget.style.background = "transparent";
          }}
        >
          {/* Only the chevron toggles expand/collapse. */}
          <span
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(node.path, !open);
            }}
            className="-m-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded p-0.5"
            style={{ color: isActive ? "var(--accent)" : "var(--text-muted)" }}
            title={open ? "收起" : "展开"}
          >
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
          {open ? (
            <FolderOpen
              size={15}
              className="shrink-0"
              style={{
                color: isActive
                  ? "var(--accent)"
                  : hidden
                    ? "var(--text-muted)"
                    : "var(--folder-icon)",
              }}
            />
          ) : (
            <Folder
              size={15}
              className="shrink-0"
              style={{
                color: isActive
                  ? "var(--accent)"
                  : hidden
                    ? "var(--text-muted)"
                    : "var(--folder-icon)",
              }}
            />
          )}
          <span className="truncate">{node.name}</span>
        </div>
        {open && node.children && (
          // Indent guide: children are inset under a hairline so deep levels
          // stay visually aligned with their parent folder.
          <div
            style={{
              marginLeft: 13,
              paddingLeft: 3,
              borderLeft: "1px solid var(--border)",
            }}
          >
            <Rows nodes={node.children} depth={depth + 1} onContextMenu={onContextMenu} />
          </div>
        )}
      </div>
    );
  }

  const { Icon, color } = fileVisual(node.name);
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
      className={`flex cursor-pointer items-center gap-1.5 rounded-md pr-2 transition-colors ${
        compactSidebar ? "py-0.5" : "py-1"
      }`}
      style={{
        paddingLeft: 8,
        opacity: isDragging ? 0.5 : 1,
        background: isActive ? "var(--active)" : "transparent",
        color: isActive
          ? "var(--accent)"
          : hidden
            ? "var(--text-muted)"
            : "var(--tree-text)",
      }}
      onMouseEnter={(e) => {
        if (!isActive) e.currentTarget.style.background = "var(--hover)";
      }}
      onMouseLeave={(e) => {
        if (!isActive) e.currentTarget.style.background = "transparent";
      }}
    >
      <Icon
        size={15}
        className="shrink-0"
        style={{
          color: isActive
            ? "var(--accent)"
            : hidden
              ? "var(--text-muted)"
              : color,
        }}
      />
      <span className="truncate">{node.name}</span>
    </div>
  );
}
