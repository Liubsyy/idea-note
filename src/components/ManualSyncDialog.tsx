import { tr } from "../i18n/core.ts";
import { useLanguage } from "../i18n/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronRight, File, FileQuestion, Folder, LoaderCircle, Plus, Sparkles, X } from "lucide-react";
import { useAppStore } from "../store/useAppStore";
import { WorkingChangePreview } from "./WorkingChangePreview";
import {
  addUntracked,
  changePaths,
  ignoreUntracked,
  listCommitCandidates,
  syncCommitMessage,
  type CommitFile,
} from "../lib/git";

/** Untracked rows rendered at most; the rest are summarized. */
const UNTRACKED_SHOWN = 300;

const STATUS_COLOR: Record<string, string> = {
  A: "var(--ansi-green)",
  D: "var(--ansi-red)",
  R: "#d97706",
  C: "#d97706",
};

const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const fileDir = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));

/**
 * 手动同步: pick which working changes to commit, write (or AI-generate) the
 * message, then commit locally or commit and push. Unchecked files stay as
 * uncommitted changes; the auto-sync timer waits while this is open.
 * Untracked files are listed apart ("未添加到 Git") and are never committed
 * until added (or ignored for good).
 */
export function ManualSyncDialog() {
  useLanguage();
  const open = useAppStore((s) => s.manualSyncOpen);
  const setOpen = useAppStore((s) => s.setManualSyncOpen);
  const workspacePath = useAppStore((s) => s.workspacePath);
  const gitInfo = useAppStore((s) => s.gitInfo);
  const syncing = useAppStore((s) => s.syncState === "syncing");
  const confirm = useAppStore((s) => s.confirm);

  const [files, setFiles] = useState<CommitFile[] | null>(null);
  const [untracked, setUntracked] = useState<string[]>([]);
  const [untrackedOpen, setUntrackedOpen] = useState(true);
  const [fileAction, setFileAction] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState("");
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<CommitFile | null>(null);
  const [contextMenu, setContextMenu] = useState<{ file: CommitFile; x: number; y: number } | null>(null);
  const allRef = useRef<HTMLInputElement>(null);

  // (Re)load the change list every time the dialog opens: save the editor
  // first so its pending edit shows up, then default to everything checked.
  useEffect(() => {
    if (!open || !workspacePath) return;
    let alive = true;
    setFiles(null);
    setUntracked([]);
    setLoadError(null);
    setGenError(null);
    setActionError(null);
    setPreview(null);
    setContextMenu(null);
    setMessage(syncCommitMessage());
    void (async () => {
      try {
        await useAppStore.getState().flushActiveTab();
        const { changes, untracked } = await listCommitCandidates(workspacePath);
        if (!alive) return;
        setFiles(changes);
        setUntracked(untracked);
        setChecked(new Set(changes.map((f) => f.path)));
        setCollapsed(new Set());
        setUntrackedOpen(untracked.length <= 20);
      } catch (e) {
        if (alive) setLoadError(tr("读取更改失败：{{0}}", { 0: e instanceof Error ? e.message : String(e) }));
      }
    })();
    return () => {
      alive = false;
    };
  }, [open, workspacePath]);

  const busy = generating || submitting || syncing || fileAction;

  /** 添加 / 忽略 untracked files, then re-list. Newly added files arrive
   *  checked; everything else keeps its current check state. */
  const actOnUntracked = async (paths: string[], action: "add" | "ignore") => {
    if (!workspacePath || !paths.length || busy) return;
    setFileAction(true);
    setActionError(null);
    try {
      if (action === "add") await addUntracked(workspacePath, paths);
      else await ignoreUntracked(workspacePath, paths);
      const next = await listCommitCandidates(workspacePath);
      const known = new Set((files ?? []).map((f) => f.path));
      setChecked((prev) => new Set(
        next.changes
          .filter((f) => prev.has(f.path) || !known.has(f.path))
          .map((f) => f.path),
      ));
      setFiles(next.changes);
      setUntracked(next.untracked);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setFileAction(false);
    }
  };
  const close = () => {
    if (!submitting && !fileAction) setOpen(false);
  };

  useEffect(() => {
    if (!contextMenu) return;
    const dismiss = () => setContextMenu(null);
    window.addEventListener("click", dismiss);
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => {
      window.removeEventListener("click", dismiss);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (confirm || useAppStore.getState().confirm) return;
        if (preview) setPreview(null);
        else if (contextMenu) setContextMenu(null);
        else close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, submitting, fileAction, preview, contextMenu, confirm]);

  const selected = useMemo(
    () => (files ?? []).filter((f) => checked.has(f.path)),
    [files, checked],
  );
  const total = files?.length ?? 0;
  // Folder groups come first, followed by root files without a folder header.
  const groups = useMemo(() => {
    const byDir = new Map<string, CommitFile[]>();
    for (const f of files ?? []) {
      const dir = fileDir(f.path);
      byDir.set(dir, [...(byDir.get(dir) ?? []), f]);
    }
    return [...byDir.entries()]
      .sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)))
      .map(([dir, list]) => ({
        dir,
        files: list.sort((a, b) => fileName(a.path).localeCompare(fileName(b.path))),
      }));
  }, [files]);
  useEffect(() => {
    if (allRef.current) allRef.current.indeterminate = selected.length > 0 && selected.length < total;
  }, [selected.length, total]);

  if (!open || !workspacePath) return null;

  const hasRemote = !!gitInfo?.remoteUrl;
  const canSubmit = selected.length > 0 && !!message.trim() && !busy;

  const toggle = (path: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const toggleAll = () =>
    setChecked(selected.length === total ? new Set() : new Set((files ?? []).map((f) => f.path)));
  const toggleGroup = (list: CommitFile[]) =>
    setChecked((prev) => {
      const next = new Set(prev);
      const all = list.every((f) => next.has(f.path));
      for (const f of list) {
        if (all) next.delete(f.path);
        else next.add(f.path);
      }
      return next;
    });
  const toggleCollapsed = (dir: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      return next;
    });

  const openFileMenu = (e: React.MouseEvent, file: CommitFile) => {
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;
    setContextMenu({
      file,
      x: Math.max(8, Math.min(e.clientX, window.innerWidth - 192 - 8)),
      y: Math.max(8, Math.min(e.clientY, window.innerHeight - 48 - 8)),
    });
  };

  const requestDiscard = (file: CommitFile) => {
    setContextMenu(null);
    if (busy) return;
    useAppStore.getState().openConfirm({
      title: tr("撤销未提交更改"),
      message: (file.status === "A"
        ? tr("「{{0}}」尚未提交过，撤销更改会删除这个文件。", { 0: file.path })
        : tr("将丢弃「{{0}}」尚未提交的更改，恢复到上次提交（HEAD）的状态。", { 0: file.path }))
        + tr("此操作不可恢复。"),
      confirmLabel: tr("撤销"),
      onConfirm: async () => {
        const state = useAppStore.getState();
        if (state.workspacePath !== workspacePath || !state.manualSyncOpen) return;
        setFileAction(true);
        setActionError(null);
        try {
          await state.discardHistoryChanges([file]);
          const next = await listCommitCandidates(workspacePath);
          setChecked((prev) => new Set(next.changes.filter((f) => prev.has(f.path)).map((f) => f.path)));
          setFiles(next.changes);
          setUntracked(next.untracked);
        } finally {
          setFileAction(false);
        }
      },
    });
  };

  const generate = async () => {
    if (!selected.length || busy) return;
    setGenerating(true);
    setGenError(null);
    try {
      const text = await useAppStore.getState().generateManualCommitMessage(changePaths(selected));
      setMessage(text);
    } catch (e) {
      setGenError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(false);
    }
  };

  const submit = async (push: boolean) => {
    if (!canSubmit) return;
    setSubmitting(true);
    const ok = await useAppStore.getState().manualSync(changePaths(selected), message.trim(), push);
    setSubmitting(false);
    // On failure the toast explains why; keep the selection for a retry.
    if (ok) setOpen(false);
  };

  return createPortal(
    <>
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center backdrop-blur-sm"
      style={{ background: "rgba(0,0,0,0.32)" }}
      onMouseDown={close}
    >
      <div
        role="dialog"
        aria-label={tr("手动同步")}
        className="mt-24 flex w-[560px] flex-col overflow-hidden rounded-xl text-sm"
        style={{
          maxWidth: "calc(100% - 32px)",
          maxHeight: "calc(100% - 128px)",
          background: "var(--bg-elev)",
          border: "1px solid var(--border)",
          boxShadow: "0 18px 54px var(--shadow)",
          color: "var(--text)",
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center gap-3 px-4 py-2.5"
          style={{ borderBottom: "1px solid var(--border)" }}
        >
          <span className="font-semibold">{tr("手动同步")}</span>
          {hasRemote && gitInfo?.branch && (
            <span className="ml-auto text-xs" style={{ color: "var(--text-muted)" }}>
              {gitInfo.branch} → origin
            </span>
          )}
          <button
            onClick={close}
            title={tr("取消")}
            className={`${hasRemote && gitInfo?.branch ? "" : "ml-auto"} flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--hover)]`}
            style={{ color: "var(--text-muted)" }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Change list */}
        <div className="min-h-0 overflow-y-auto px-1.5 py-1.5" style={{ borderBottom: "1px solid var(--border)" }}>
          {loadError ? (
            <p className="m-0 px-3 py-4" style={{ color: "var(--ansi-red)" }}>{loadError}</p>
          ) : !files ? (
            <p className="m-0 flex items-center gap-2 px-3 py-4" style={{ color: "var(--text-muted)" }}>
              <LoaderCircle size={14} className="animate-spin" />
              {tr("正在读取更改…")}
            </p>
          ) : !files.length && !untracked.length ? (
            <p className="m-0 px-3 py-4" style={{ color: "var(--text-muted)" }}>{tr("没有需要提交的更改")}</p>
          ) : (
            <>
              {!files.length && (
                <p className="m-0 px-3 py-2" style={{ color: "var(--text-muted)" }}>{tr("没有需要提交的更改")}</p>
              )}
              {files.length > 0 && (
              <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1">
                <ChevronDown size={13} style={{ color: "var(--text-muted)" }} />
                <input
                  ref={allRef}
                  type="checkbox"
                  checked={selected.length === total}
                  onChange={toggleAll}
                  style={{ accentColor: "var(--accent)" }}
                />
                <span className="font-medium">{tr("更改")}</span>
                <span style={{ color: "var(--text-muted)" }}>
                  {tr("{{0}} 个文件 · 已选 {{1}}", { 0: total, 1: selected.length })}
                </span>
              </label>
              )}
              {groups.map(({ dir, files: list }) => {
                const picked = list.filter((f) => checked.has(f.path)).length;
                const open = !dir || !collapsed.has(dir);
                return (
                  <div key={dir}>
                    {dir && <div className="flex items-center gap-2 rounded-md py-1 pl-4 pr-2 hover:bg-[var(--hover)]">
                      <button
                        type="button"
                        onClick={() => toggleCollapsed(dir)}
                        className="flex shrink-0 items-center"
                        style={{ color: "var(--text-muted)" }}
                      >
                        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                      </button>
                      <input
                        type="checkbox"
                        checked={picked === list.length}
                        ref={(el) => {
                          if (el) el.indeterminate = picked > 0 && picked < list.length;
                        }}
                        onChange={() => toggleGroup(list)}
                        style={{ accentColor: "var(--accent)" }}
                      />
                      <button
                        type="button"
                        onClick={() => toggleCollapsed(dir)}
                        title={dir}
                        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                      >
                        <Folder size={14} className="shrink-0" style={{ color: "var(--text-muted)" }} />
                        <span className="truncate">{dir}</span>
                        <span className="shrink-0 text-xs" style={{ color: "var(--text-muted)" }}>
                          {list.length}
                        </span>
                      </button>
                    </div>}
                    {open &&
                      list.map((f) => (
                        <label
                          key={f.path}
                          title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
                          onContextMenu={(e) => openFileMenu(e, f)}
                          className={`flex cursor-pointer items-center gap-2 rounded-md py-1 ${dir ? "pl-[52px]" : "pl-[37px]"} pr-2 hover:bg-[var(--hover)]`}
                        >
                          <input
                            type="checkbox"
                            checked={checked.has(f.path)}
                            onChange={() => toggle(f.path)}
                            style={{ accentColor: "var(--accent)" }}
                          />
                          <button
                            type="button"
                            title={tr("双击查看修改内容")}
                            onDoubleClick={() => setPreview(f)}
                            onClick={(e) => { if (e.detail === 0) setPreview(f); }}
                            className="min-w-0 flex-1 truncate text-left"
                            style={{
                              color: STATUS_COLOR[f.status] ?? "var(--accent)",
                              textDecoration: f.status === "D" ? "line-through" : undefined,
                            }}
                          >
                            {fileName(f.path)}
                          </button>
                          <span
                            className="w-3 shrink-0 text-center text-[11px] font-semibold"
                            style={{ color: STATUS_COLOR[f.status] ?? "var(--accent)" }}
                          >
                            {f.status}
                          </span>
                        </label>
                      ))}
                  </div>
                );
              })}
              {untracked.length > 0 && (
                <div
                  className={files.length ? "mt-1.5 pt-1.5" : ""}
                  style={files.length ? { borderTop: "1px dashed var(--border)" } : undefined}
                >
                  <div className="flex items-center gap-2 rounded-md px-2 py-1">
                    <button
                      type="button"
                      onClick={() => setUntrackedOpen((v) => !v)}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    >
                      <span style={{ color: "var(--text-muted)" }}>
                        {untrackedOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                      </span>
                      <FileQuestion size={15} className="shrink-0" style={{ color: "var(--text-muted)" }} />
                      <span className="font-medium">{tr("未添加到 Git")}</span>
                      <span className="truncate" style={{ color: "var(--text-muted)" }}>
                        {tr("{{0}} 个文件 · 不会提交", { 0: untracked.length })}
                      </span>
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void actOnUntracked(untracked, "add")}
                      className="flex shrink-0 items-center gap-0.5 rounded-md px-1.5 py-0.5 text-xs transition-colors hover:bg-[var(--hover)] disabled:opacity-40"
                      style={{ color: "var(--accent)" }}
                    >
                      <Plus size={13} />
                      {tr("全部添加")}
                    </button>
                  </div>
                  {untrackedOpen &&
                    untracked.slice(0, UNTRACKED_SHOWN).map((path) => (
                      <div
                        key={path}
                        title={path}
                        onContextMenu={(e) => openFileMenu(e, { path, status: "A" })}
                        className="group flex items-center gap-2 rounded-md py-1 pl-10 pr-2 hover:bg-[var(--hover)]"
                        style={{ color: "var(--text-soft)" }}
                      >
                        <File size={14} className="shrink-0" style={{ color: "var(--text-muted)" }} />
                        <button
                          type="button"
                          title={tr("双击查看修改内容")}
                          onDoubleClick={() => setPreview({ path, status: "A" })}
                          onClick={(e) => { if (e.detail === 0) setPreview({ path, status: "A" }); }}
                          className="truncate text-left"
                        >
                          {fileName(path)}
                        </button>
                        <span className="min-w-0 flex-1 truncate text-xs" style={{ color: "var(--text-muted)" }}>
                          {fileDir(path) || tr("根目录")}
                        </span>
                        <span className="hidden shrink-0 gap-1.5 group-hover:flex">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void actOnUntracked([path], "add")}
                            className="rounded-md px-2 text-xs disabled:opacity-40"
                            style={{ border: "1px solid var(--border)", color: "var(--accent)" }}
                          >
                            {tr("添加")}
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void actOnUntracked([path], "ignore")}
                            className="rounded-md px-2 text-xs disabled:opacity-40"
                            style={{ border: "1px solid var(--border)" }}
                          >
                            {tr("忽略")}
                          </button>
                        </span>
                      </div>
                    ))}
                  {untrackedOpen && untracked.length > UNTRACKED_SHOWN && (
                    <p className="m-0 py-1 pl-10 text-xs" style={{ color: "var(--text-muted)" }}>
                      {tr("还有 {{0}} 个文件未显示", { 0: untracked.length - UNTRACKED_SHOWN })}
                    </p>
                  )}
                </div>
              )}
              {actionError && (
                <p className="m-0 px-3 py-1 text-xs" style={{ color: "var(--ansi-red)" }}>{actionError}</p>
              )}
            </>
          )}
        </div>

        {/* Commit message */}
        <div className="px-4 py-2.5">
          <div className="mb-1.5 flex items-center justify-between">
            <span style={{ color: "var(--text-soft)" }}>{tr("提交记录")}</span>
            <button
              type="button"
              onClick={() => void generate()}
              disabled={!selected.length || busy}
              className="flex items-center gap-1 rounded-md px-2 py-0.5 text-xs transition-colors hover:bg-[var(--hover)] disabled:cursor-default disabled:opacity-40"
              style={{ border: "1px solid var(--border)" }}
            >
              {generating ? (
                <LoaderCircle size={13} className="animate-spin" />
              ) : (
                <Sparkles size={13} style={{ color: "var(--accent)" }} />
              )}
              {generating ? tr("生成中…") : tr("AI 生成")}
            </button>
          </div>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={3}
            disabled={generating}
            className="w-full resize-none rounded-lg px-2.5 py-2 text-sm outline-none"
            style={{ background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)" }}
          />
          {genError && (
            <p className="m-0 mt-1 text-xs" style={{ color: "var(--ansi-red)" }}>{genError}</p>
          )}
        </div>

        <div className="flex items-center gap-2 px-4 py-2.5" style={{ borderTop: "1px solid var(--border)" }}>
          <span className="min-w-0 flex-1 truncate text-xs" style={{ color: "var(--text-muted)" }}>
            {tr("未勾选和未添加的文件不会被提交")}
          </span>
          {hasRemote && (
            <button
              type="button"
              disabled={!canSubmit}
              onClick={() => void submit(false)}
              className="rounded-md px-3 py-1 transition-colors hover:bg-[var(--hover)] disabled:cursor-default disabled:opacity-40"
              style={{ border: "1px solid var(--border)" }}
            >
              {tr("仅提交")}
            </button>
          )}
          <button
            type="button"
            disabled={!canSubmit}
            onClick={() => void submit(hasRemote)}
            className="flex items-center gap-1.5 rounded-md px-3 py-1 text-white transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-40"
            style={{ background: "var(--accent)" }}
          >
            {submitting && <LoaderCircle size={13} className="animate-spin" />}
            {hasRemote ? tr("提交并推送") : tr("提交")}
          </button>
        </div>
      </div>
    </div>
    {contextMenu && (
      <div
        role="menu"
        className="fixed z-[75] w-48 rounded-lg py-1 text-sm shadow-lg"
        style={{ left: contextMenu.x, top: contextMenu.y, background: "var(--bg-elev)", border: "1px solid var(--border)" }}
        onContextMenu={(e) => e.preventDefault()}
      >
        <button
          type="button"
          role="menuitem"
          disabled={busy}
          onClick={() => requestDiscard(contextMenu.file)}
          className="w-full px-3 py-1.5 text-left hover:bg-[var(--hover)] disabled:opacity-40"
          style={{ color: "var(--ansi-red)" }}
        >
          {tr("撤销更改")}
        </button>
      </div>
    )}
    {preview && (
      <WorkingChangePreview
        key={preview.path}
        workspacePath={workspacePath}
        file={preview}
        onClose={() => setPreview(null)}
      />
    )}
    </>,
    document.body,
  );
}
