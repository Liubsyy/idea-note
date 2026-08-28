import { useEffect, useMemo, useRef } from "react";
import {
  ChevronDown,
  ChevronRight,
  FileInput,
  LocateFixed,
  Play,
  Square,
  SquareTerminal,
  Trash2,
  X,
} from "lucide-react";

import { useAppStore } from "../../store/useAppStore";
import { useRunStore, type RunRecord } from "../../store/useRunStore";
import { runInTerminal, startRun, stopRun } from "../../lib/codeRun/run";
import { parseAnsiSegments } from "../../lib/codeRun/ansi";
import { insertOutput, revealBlock } from "../../lib/codeRun/document";
import { basename } from "../../lib/fs";

/**
 * The dedicated 运行输出 panel: one card per run of a code block in the current
 * note, newest first.
 *
 * Results are attributed by the code's first line rather than by position, so
 * the panel stays correct while the note is edited around the block. Records
 * are filtered to the active file — a run belongs to the note it came from.
 */

const STATUS_LABEL = (record: RunRecord): string => {
  switch (record.status) {
    case "running":
      return "运行中";
    case "timeout":
      return "已超时";
    case "killed":
      return "已停止";
    case "error":
      return "启动失败";
    default:
      return record.exitCode === null ? "已结束" : `退出码 ${record.exitCode}`;
  }
};

const STATUS_COLOR = (record: RunRecord): string => {
  if (record.status === "running") return "var(--accent)";
  if (record.status === "done" && record.exitCode === 0) return "var(--file-image)";
  if (record.status === "killed" || record.status === "timeout")
    return "var(--note-icon)";
  return "var(--danger, #e5484d)";
};

/** A run that ended in a way the pipeline can't fix — no stdin, no TTY, or it
 *  simply never finishes. The terminal can do all three. */
function needsTerminal(record: RunRecord): boolean {
  if (record.status === "timeout") return true;
  return record.segs.some(
    (s) => s.stream === "stderr" && /EOFError|EOF when reading|stdin/i.test(s.text),
  );
}

const formatMs = (ms: number) => (ms < 1000 ? `${ms} 毫秒` : `${(ms / 1000).toFixed(1)} 秒`);

/** The panel owns its clear/close actions; opening it lives on every code block
 *  instead of in the app title bar. */
function RunPanelActions() {
  const activeFilePath = useAppStore((s) => s.activeFilePath);
  const toggleRunPanel = useAppStore((s) => s.toggleRunPanel);
  const clearFile = useRunStore((s) => s.clearFile);

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <button
        title="清空运行输出"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={() => clearFile(activeFilePath ?? "")}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-[var(--hover)]"
        style={{ color: "var(--text-muted)" }}
      >
        <Trash2 size={15} />
      </button>
      <button
        title="关闭运行输出"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={toggleRunPanel}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-[var(--hover)]"
        style={{ color: "var(--text-muted)" }}
      >
        <X size={15} />
      </button>
    </div>
  );
}

export function RunOutputPanel() {
  const activeFilePath = useAppStore((s) => s.activeFilePath);
  const records = useRunStore((s) => s.records);
  const visible = useMemo(
    () => records.filter((r) => r.filePath === (activeFilePath ?? "")),
    [records, activeFilePath],
  );

  return (
    <>
      <div
        data-tauri-drag-region
        className="flex h-11 shrink-0 items-center gap-2 px-2"
        style={{ borderBottom: "1px solid var(--border)", background: "var(--sidebar-bg)" }}
      >
        <Play size={14} className="shrink-0" style={{ color: "var(--accent)" }} />
        <span className="shrink-0 text-[0.923em] font-medium" style={{ color: "var(--text)" }}>
          运行输出
        </span>
        <span
          data-tauri-drag-region
          className="min-w-0 flex-1 truncate text-[0.923em]"
          style={{ color: "var(--text-muted)" }}
        >
          {activeFilePath ? basename(activeFilePath) : "未打开笔记"}
        </span>
        <RunPanelActions />
      </div>

      <div className="scroll-auto-hide min-h-0 flex-1 overflow-y-auto p-2">
        {visible.length === 0 ? (
          <div
            className="px-2 py-6 text-center text-[0.923em] leading-relaxed"
            style={{ color: "var(--text-muted)" }}
          >
            还没有运行结果。
            <br />
            在代码块右上角点「运行」。
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {visible.map((record) => (
              <RunCard key={record.runId} record={record} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

/** Standalone right-side panel; its open state and width are independent from
 *  the AI assistant panel. */
export function RunPanel() {
  const fontSize = useAppStore((s) => s.codeRunConfig.fontSize);

  return (
    <div
      className="flex h-full w-full flex-col overflow-hidden"
      style={{
        borderLeft: "1px solid var(--border)",
        background: "var(--bg)",
        fontSize: `${fontSize}px`,
      }}
    >
      <RunOutputPanel />
    </div>
  );
}

function IconButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      aria-label={title}
      onClick={onClick}
      className="flex h-5 w-5 shrink-0 items-center justify-center rounded transition-colors"
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
      {children}
    </button>
  );
}

function RunCard({ record }: { record: RunRecord }) {
  const setCollapsed = useRunStore((s) => s.setCollapsed);
  const showToast = useAppStore((s) => s.showToast);
  const bodyRef = useRef<HTMLDivElement>(null);
  const collapsed = record.collapsed;
  const outputRuns = useMemo(() => parseAnsiSegments(record.segs), [record.segs]);

  // Follow the output while it streams, the way a terminal does.
  useEffect(() => {
    if (record.status !== "running") return;
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [record.segs, record.status]);

  const locate = (action: () => boolean, failure: string) => {
    if (!action()) showToast(failure, "error");
  };

  return (
    <div
      className="overflow-hidden rounded-lg"
      style={{ border: "1px solid var(--border)", background: "var(--bg-elev)" }}
    >
      <div
        className="flex items-center gap-1.5 px-2 py-1.5"
        style={{ borderBottom: collapsed ? "none" : "1px solid var(--border)" }}
      >
        <button
          title={collapsed ? "展开" : "折叠"}
          aria-label={collapsed ? "展开" : "折叠"}
          onClick={() => setCollapsed(record.runId, !collapsed)}
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded"
          style={{ color: "var(--text-muted)" }}
        >
          {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        </button>
        <span
          className="shrink-0 rounded px-1.5 py-0.5 text-[0.77em]"
          style={{
            color: STATUS_COLOR(record),
            border: `1px solid ${STATUS_COLOR(record)}`,
          }}
        >
          {STATUS_LABEL(record)}
        </span>
        <span
          className="min-w-0 flex-1 truncate font-mono text-[0.77em]"
          style={{ color: "var(--text-muted)" }}
          title={record.firstLine}
        >
          {record.firstLine}
        </span>
        {record.status === "running" ? (
          <IconButton title="停止" onClick={() => stopRun(record.runId)}>
            <Square size={11} />
          </IconButton>
        ) : (
          <IconButton
            title="重跑"
            onClick={() =>
              void startRun({
                filePath: record.filePath || null,
                info: record.lang,
                code: record.code,
              })
            }
          >
            <Play size={12} />
          </IconButton>
        )}
        <IconButton
          title="插入到文档"
          onClick={() =>
            locate(() => insertOutput(record), "找不到对应的代码块（可能已被修改）")
          }
        >
          <FileInput size={12} />
        </IconButton>
        <IconButton
          title="跳到代码块"
          onClick={() =>
            locate(() => revealBlock(record), "找不到对应的代码块（可能已被修改）")
          }
        >
          <LocateFixed size={12} />
        </IconButton>
      </div>

      {!collapsed && (
        <>
          <div
            ref={bodyRef}
            className="scroll-auto-hide max-h-[40vh] overflow-y-auto px-2.5 py-2"
          >
            {record.error ? (
              <pre
                className="whitespace-pre-wrap break-words font-mono text-[0.85em] leading-relaxed"
                style={{ color: "var(--danger, #e5484d)" }}
              >
                {record.error}
              </pre>
            ) : record.segs.length === 0 ? (
              <div className="text-[0.85em]" style={{ color: "var(--text-muted)" }}>
                {record.status === "running" ? "等待输出…" : "没有输出"}
              </div>
            ) : (
              <pre className="whitespace-pre-wrap break-words font-mono text-[0.85em] leading-relaxed">
                {outputRuns.map((run, i) => (
                  <span key={i} style={run.style}>
                    {run.text}
                  </span>
                ))}
              </pre>
            )}
          </div>

          <div
            className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2.5 pb-2 text-[0.77em]"
            style={{ color: "var(--text-muted)" }}
          >
            <span className="truncate font-mono">{record.command}</span>
            {record.status !== "running" && <span>{formatMs(record.ms)}</span>}
            {record.truncated && <span>输出已截断</span>}
          </div>

          {needsTerminal(record) && (
            <div
              className="flex items-center gap-2 px-2.5 pb-2 text-[0.77em]"
              style={{ color: "var(--text-muted)" }}
            >
              <span className="min-w-0 flex-1">
                这段代码可能需要交互或长期运行，试试在终端里跑。
              </span>
              <button
                onClick={() => void runInTerminal(record.lang, record.code)}
                className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 transition-colors"
                style={{ border: "1px solid var(--border)", color: "var(--text)" }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "var(--hover)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                <SquareTerminal size={11} />
                在终端运行
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
