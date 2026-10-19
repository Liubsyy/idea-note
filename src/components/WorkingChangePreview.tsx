import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { tr } from "../i18n/core.ts";
import { useLanguage } from "../i18n/react";
import { isBinaryImageFile } from "../lib/fs";
import { readWorkingChange, type CommitFile } from "../lib/git";
import { DiffView } from "./HistoryModal";

/** A read-only preview stacked over Manual sync, keeping its form mounted. */
export function WorkingChangePreview({
  workspacePath,
  file,
  onClose,
}: {
  workspacePath: string;
  file: CommitFile;
  onClose: () => void;
}) {
  useLanguage();
  const [diff, setDiff] = useState<{ oldText: string; newText: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [binary, setBinary] = useState(isBinaryImageFile(file.path));

  useEffect(() => {
    let cancelled = false;
    setDiff(null);
    setError(null);
    setBinary(isBinaryImageFile(file.path));
    if (!isBinaryImageFile(file.path)) {
      readWorkingChange(workspacePath, file).then((value) => {
        if (cancelled) return;
        if (value.oldText.includes("\0") || value.newText.includes("\0")) setBinary(true);
        else setDiff(value);
      }).catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    }
    return () => { cancelled = true; };
  }, [workspacePath, file]);

  return (
    <div
      className="fixed inset-0 z-[70] backdrop-blur-sm"
      style={{ background: "rgba(0,0,0,0.35)" }}
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={tr("修改内容")}
        className="absolute inset-8 flex flex-col overflow-hidden rounded-xl"
        style={{
          background: "var(--bg-elev)", color: "var(--text)",
          border: "1px solid var(--border)", boxShadow: "0 18px 54px var(--shadow)",
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex h-11 shrink-0 items-center gap-3 px-4" style={{ borderBottom: "1px solid var(--border)" }}>
          <span className="shrink-0 text-sm font-semibold">{tr("修改内容")}</span>
          <span className="min-w-0 flex-1 truncate text-xs" title={file.path} style={{ color: "var(--text-muted)" }}>
            {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
          </span>
          <button
            type="button"
            autoFocus
            title={tr("关闭")}
            aria-label={tr("关闭")}
            onClick={onClose}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md hover:bg-[var(--hover)]"
            style={{ color: "var(--text-muted)" }}
          >
            <X size={16} />
          </button>
        </div>
        <div className="flex h-8 shrink-0 items-center px-4 text-xs" style={{ borderBottom: "1px solid var(--border)", color: "var(--text-muted)" }}>
          {tr("上次提交（HEAD） / 当前内容")}
        </div>
        {binary || error || !diff ? (
          <div className="flex min-h-0 flex-1 items-center justify-center p-8 text-sm" style={{ color: error ? "var(--ansi-red)" : "var(--text-muted)" }}>
            {binary ? tr("图片等二进制文件无法显示差异") : error ? tr("读取更改失败：{{0}}", { 0: error }) : tr("加载差异…")}
          </div>
        ) : (
          <DiffView oldText={diff.oldText} newText={diff.newText} path={file.path} />
        )}
      </div>
    </div>
  );
}
