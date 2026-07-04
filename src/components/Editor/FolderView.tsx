import { ChevronRight, FileText, Folder, Image as ImageIcon } from "lucide-react";
import { findNode, isImageFile, isMarkdownFile } from "../../lib/fs";
import type { FileNode } from "../../lib/fs";
import { useAppStore } from "../../store/useAppStore";

/**
 * Right-pane listing of a folder's contents, shown when a folder is selected
 * and it has no README.md to open. A centered, single-column list: one entry
 * per row. Clicking an entry drills in (folders) or opens the file (files).
 */
export function FolderView({ path }: { path: string }) {
  const tree = useAppStore((s) => s.tree);
  const openFile = useAppStore((s) => s.openFile);
  const openFolder = useAppStore((s) => s.openFolder);
  const newFile = useAppStore((s) => s.newFile);

  const node = findNode(tree, path);
  const children = node?.children ?? [];
  const createReadme = () => newFile(path, "README.md");

  if (children.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-sm">
        <div className="text-center">
          <div style={{ color: "var(--text-muted)" }}>此文件夹为空</div>
          <ReadmeHint onCreate={createReadme} />
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto px-6 py-8">
      {/* Centered, width-constrained column. */}
      <div className="mx-auto w-full max-w-[520px]">
        <div className="mb-3 px-1">
          <div className="text-center text-xs" style={{ color: "var(--text-muted)" }}>
            共 {children.length} 项
          </div>
          <ReadmeHint onCreate={createReadme} />
        </div>
        <div
          className="overflow-hidden rounded-xl [&>*+*]:border-t"
          style={{ background: "var(--bg-elev)", border: "1px solid var(--border)" }}
        >
          {children.map((child) => (
            <Entry
              key={child.path}
              node={child}
              onOpen={() => (child.is_dir ? openFolder(child) : openFile(child.path))}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function ReadmeHint({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="mt-2 flex items-center justify-center gap-3 text-xs">
      <span style={{ color: "var(--text-muted)" }}>
        当文件夹中有README.md时将显示README.md。
      </span>
      <button
        onClick={onCreate}
        className="shrink-0 underline-offset-2 hover:underline"
        style={{ color: "var(--accent)" }}
      >
        创建README.md
      </button>
    </div>
  );
}

function Entry({ node, onOpen }: { node: FileNode; onOpen: () => void }) {
  const icon = node.is_dir ? (
    <Folder size={18} style={{ color: "var(--accent)" }} />
  ) : isImageFile(node.name) ? (
    <ImageIcon size={18} style={{ color: "var(--text-muted)" }} />
  ) : (
    <FileText
      size={18}
      style={{ color: isMarkdownFile(node.name) ? "var(--accent)" : "var(--text-muted)" }}
    />
  );

  return (
    <button
      onClick={onOpen}
      className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors"
      style={{ borderColor: "var(--border)" }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--hover)")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-sm" style={{ color: "var(--text)" }}>
        {node.name}
      </span>
      {node.is_dir && (
        <ChevronRight size={15} className="shrink-0" style={{ color: "var(--text-muted)" }} />
      )}
    </button>
  );
}
