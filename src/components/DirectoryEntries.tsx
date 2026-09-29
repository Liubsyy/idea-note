import { useState, type ReactNode } from "react";

const BATCH_SIZE = 1000;

interface Props<T> {
  directory: string;
  entries: T[];
  children: (visible: T[]) => ReactNode;
}

/** Keep the limit local to this mounted directory, never in persisted settings. */
export function DirectoryEntries<T>({ directory, ...props }: Props<T>) {
  return <Batch key={directory} {...props} />;
}

function Batch<T>({ entries, children }: Omit<Props<T>, "directory">) {
  const [limit, setLimit] = useState(BATCH_SIZE);
  const shown = Math.min(limit, entries.length);
  const remaining = entries.length - shown;
  const format = (count: number) => count.toLocaleString("zh-CN");

  return (
    <>
      {children(entries.slice(0, shown))}
      {entries.length > BATCH_SIZE && (
        <div
          className="mx-2 my-2 border-t pt-2 text-xs"
          style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}
          // Loading more is not a click on empty sidebar space: keep selection.
          onClick={(e) => e.stopPropagation()}
        >
          <div role="status">已显示 {format(shown)} / {format(entries.length)} 项</div>
          {remaining > 0 ? (
            <button
              type="button"
              className="my-2 inline-flex rounded px-2.5 py-1 text-xs hover:opacity-80"
              style={{ color: "var(--accent)", background: "var(--active)" }}
              onClick={() => setLimit((current) => Math.min(Math.min(current, entries.length) + BATCH_SIZE, entries.length))}
            >
              显示更多
            </button>
          ) : (
            <div className="mt-1">已全部显示</div>
          )}
        </div>
      )}
    </>
  );
}
