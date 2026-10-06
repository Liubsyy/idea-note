import { tr, currentLanguage } from "../i18n/core.ts";
import { useLanguage } from "../i18n/react";
import { useEffect, useRef, useState } from "react";
import { History, X } from "lucide-react";
import { MergeView } from "@codemirror/merge";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { GFM } from "@lezer/markdown";
import { useAppStore } from "../store/useAppStore";
import { basename, isImageFile, isMarkdownFile, readFile } from "../lib/fs";
import { inlineMath } from "../lib/codemirror/math";
import { cmHighlighting, cmHistoryDiffTheme } from "../lib/codemirror/theme";
import { relativePathWithinWorkspace } from "../lib/workspacePath";
import {
  listFileHistory,
  listDirHistory,
  listCommitFiles,
  listWorkingChanges,
  readFileAtCommit,
  readFileAtRev,
  getRepoRoot,
  workingEntry,
  isWorkingCommit,
  GitError,
  type FileCommit,
  type CommitFile,
} from "../lib/git";

/**
 * Full-screen history overlay. File history opens as a two-tab dialog:
 * current file + global project history. Directory entries from the sidebar
 * keep their scoped folder/project history view.
 */
export function HistoryModal() {
  useLanguage();
  const history = useAppStore((s) => s.history);
  if (!history) return null;
  // Key on the path so every open starts with fresh state.
  return history.kind === "file" ? (
    <TabbedHistoryDialog key={history.path} path={history.path} />
  ) : (
    <DirHistoryDialog key={history.path} path={history.path} />
  );
}

function formatRelTime(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return tr("刚刚");
  if (min < 60) return tr("{{0}} 分钟前", { 0: min });
  const hours = Math.floor(min / 60);
  if (hours < 24) return tr("{{0}} 小时前", { 0: hours });
  const days = Math.floor(hours / 24);
  if (days < 30) return tr("{{0}} 天前", { 0: days });
  return new Date(ts).toLocaleDateString(currentLanguage());
}

const errMessage = (e: unknown) =>
  e instanceof GitError || e instanceof Error ? e.message : String(e);

/* --------------------------------- shell -------------------------------- */

function HistoryShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useLanguage();
  // Escape closes the dialog — unless a confirmation is stacked on top
  // (z-60), which owns Escape at that moment.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && useAppStore.getState().confirm === null) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 backdrop-blur-sm"
      style={{ background: "rgba(0,0,0,0.35)" }}
      onMouseDown={onClose}
    >
      <div
        className="absolute inset-8 flex flex-col overflow-hidden rounded-xl"
        style={{
          background: "var(--bg-elev)",
          border: "1px solid var(--border)",
          boxShadow: "0 18px 54px var(--shadow)",
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div
          className="flex h-11 shrink-0 items-center gap-2 px-4"
          style={{ borderBottom: "1px solid var(--border)" }}
        >
          <History size={15} style={{ color: "var(--text-muted)" }} />
          <span className="text-[13px] font-semibold" style={{ color: "var(--text)" }}>
            {title}
          </span>
          <div className="flex-1" />
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-md"
            style={{ color: "var(--text-muted)" }}
            title={tr("关闭")}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "var(--hover)";
              e.currentTarget.style.color = "var(--text)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
              e.currentTarget.style.color = "var(--text-muted)";
            }}
          >
            <X size={15} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function CenterNote({ children, color }: { children: React.ReactNode; color?: string }) {
  useLanguage();
  return (
    <div
      className="flex flex-1 items-center justify-center px-8 text-center text-[12.5px]"
      style={{ color: color ?? "var(--text-muted)" }}
    >
      {children}
    </div>
  );
}

function HistoryTabButton({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: React.ReactNode;
  onClick: () => void;
}) {
  useLanguage();
  return (
    <button
      onClick={onClick}
      className="h-7 rounded-md px-3 text-[12px] font-medium transition-colors"
      style={{
        background: active ? "var(--active)" : "transparent",
        color: active ? "var(--text)" : "var(--text-muted)",
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

function HistoryActionButton({
  children,
  onClick,
  disabled,
  tone = "neutral",
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tone?: "neutral" | "primary" | "danger";
  title?: string;
}) {
  useLanguage();
  const danger = tone === "danger";
  const primary = tone === "primary";
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="h-6 shrink-0 whitespace-nowrap rounded-md px-2.5 text-[11px] font-medium transition-opacity"
      style={{
        background: primary
          ? "var(--accent)"
          : danger
            ? "color-mix(in srgb, var(--danger, #e5484d) 11%, transparent)"
            : "var(--bg)",
        border: primary
          ? "1px solid var(--accent)"
          : danger
            ? "1px solid color-mix(in srgb, var(--danger, #e5484d) 28%, var(--border))"
            : "1px solid var(--border)",
        color: primary ? "#fff" : danger ? "var(--danger, #e5484d)" : "var(--text)",
        opacity: disabled ? 0.45 : 1,
      }}
    >
      {children}
    </button>
  );
}

/* ------------------------------ commit list ----------------------------- */

function CommitList({
  commits,
  selected,
  onSelect,
}: {
  commits: FileCommit[];
  selected: FileCommit | null;
  onSelect: (c: FileCommit) => void;
}) {
  useLanguage();
  return (
    <div
      className="w-72 shrink-0 overflow-y-auto py-1"
      style={{ borderRight: "1px solid var(--border)" }}
    >
      {commits.map((c) => {
        const active = selected?.hash === c.hash;
        const working = isWorkingCommit(c);
        return (
          <button
            key={c.hash}
            onClick={() => onSelect(c)}
            className="block w-full px-3 py-2 text-left"
            style={{ background: active ? "var(--active)" : "transparent" }}
            onMouseEnter={(e) => {
              if (!active) e.currentTarget.style.background = "var(--hover)";
            }}
            onMouseLeave={(e) => {
              if (!active) e.currentTarget.style.background = "transparent";
            }}
          >
            <div
              className="truncate text-[12.5px]"
              style={{
                color: working ? "var(--note-icon)" : "var(--text)",
                fontWeight: working ? 500 : undefined,
              }}
              title={c.subject}
            >
              {c.subject || tr("（无提交说明）")}
            </div>
            <div className="mt-0.5 truncate text-[11px]" style={{ color: "var(--text-muted)" }}>
              {working ? (
                tr("当前工作区 · 尚未提交")
              ) : (
                <>
                  {formatRelTime(c.timestamp)} · {c.author} ·{" "}
                  <span className="font-mono">{c.shortHash}</span>
                </>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}

/* ----------------------------- file history ----------------------------- */

function TabbedHistoryDialog({ path }: { path: string }) {
  useLanguage();
  const workspacePath = useAppStore((s) => s.workspacePath);
  const closeHistory = useAppStore((s) => s.closeHistory);
  const [tab, setTab] = useState<"file" | "global">("file");

  return (
    <HistoryShell title={tr("历史记录 — {{0}}", { 0: basename(path) })} onClose={closeHistory}>
      <div className="flex min-h-0 flex-1 flex-col">
        <div
          className="flex h-10 shrink-0 items-center gap-1 px-3"
          style={{ borderBottom: "1px solid var(--border)" }}
        >
          <HistoryTabButton active={tab === "file"} onClick={() => setTab("file")}>
            {tr("当前文件")}</HistoryTabButton>
          <HistoryTabButton active={tab === "global"} onClick={() => setTab("global")}>
            {tr("全局历史")}</HistoryTabButton>
        </div>
        <div className="flex min-h-0 flex-1">
          {tab === "file" ? (
            <FileHistoryContent key={path} path={path} />
          ) : workspacePath ? (
            <DirHistoryContent key={workspacePath} path={workspacePath} />
          ) : (
            <CenterNote>{tr("还没有打开工作区")}</CenterNote>
          )}
        </div>
      </div>
    </HistoryShell>
  );
}

function FileHistoryContent({ path }: { path: string }) {
  useLanguage();
  const workspacePath = useAppStore((s) => s.workspacePath);
  if (!workspacePath) return <CenterNote>{tr("还没有打开工作区")}</CenterNote>;
  const relPath = relativePathWithinWorkspace(workspacePath, path);
  if (!relPath) return <CenterNote>{tr("当前文件不属于此项目，无法查看文件历史。可切换到「全局历史」查看项目记录。")}</CenterNote>;
  return <ScopedFileHistoryContent key={JSON.stringify([workspacePath, path])}
    path={path} workspacePath={workspacePath} relPath={relPath} />;
}

function ScopedFileHistoryContent({ path, workspacePath, relPath }: { path: string; workspacePath: string; relPath: string }) {
  useLanguage();
  const activeFilePath = useAppStore((s) => s.activeFilePath);
  const editorContent = useAppStore((s) => s.content);
  const openConfirm = useAppStore((s) => s.openConfirm);
  const rollbackToVersion = useAppStore((s) => s.rollbackToVersion);
  const discardHistoryChanges = useAppStore((s) => s.discardHistoryChanges);

  const [commits, setCommits] = useState<FileCommit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<FileCommit | null>(null);
  const [workingFile, setWorkingFile] = useState<CommitFile | null>(null);
  const [baseContent, setBaseContent] = useState<string | null>(null);
  const [selectedContent, setSelectedContent] = useState<string | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  // Right side of the diff: the live editor content when this IS the open
  // file; otherwise (opened from the sidebar context menu) the file on disk.
  const isActiveFile = activeFilePath === path;
  const [diskContent, setDiskContent] = useState<string | null>(null);
  const [currentError, setCurrentError] = useState<string | null>(null);
  useEffect(() => {
    if (isActiveFile) return;
    let cancelled = false;
    readFile(path)
      .then((text) => !cancelled && setDiskContent(text))
      .catch((e) => !cancelled && setCurrentError(errMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [isActiveFile, path]);
  const content = isActiveFile ? editorContent : diskContent;

  // Load the commit list once per open; a dirty working tree adds a
  // "未提交的更改" pseudo-entry on top.
  useEffect(() => {
    if (!workspacePath) return;
    let cancelled = false;
    Promise.all([
      listFileHistory(workspacePath, relPath),
      listWorkingChanges(workspacePath, relPath).catch(() => []),
    ])
      .then(([list, working]) => {
        if (cancelled) return;
        const w = working[0];
        setWorkingFile(w ?? null);
        // The entry carries the file's HEAD-side path so `show HEAD:path`
        // works even across an uncommitted rename.
        const all = w
          ? [workingEntry(w.oldPath ?? w.path, tr("未提交的更改")), ...list]
          : list;
        setCommits(all);
        setSelected(all[0] ?? null);
      })
      .catch((e) => !cancelled && setError(errMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [workspacePath, relPath, reloadToken]);

  // Load the comparison pair. Normal commits show what that commit changed:
  // parent version -> selected version. The working entry shows the last
  // committed state (HEAD) -> the working-tree file on disk — the same thing
  // git means by "uncommitted changes" (and what the global history tab shows).
  // Diffing against the live editor buffer instead would miss on-disk changes
  // the editor hasn't loaded, leaving the diff empty even when git is dirty.
  useEffect(() => {
    if (!workspacePath || !selected) return;
    let cancelled = false;
    setBaseContent(null);
    setSelectedContent(null);
    setDiffError(null);
    const load = isWorkingCommit(selected)
      ? Promise.all([
          readFileAtRev(workspacePath, "HEAD", selected.path),
          readFile(path).catch(() => null),
        ]).then(([base, disk]) => [base ?? "", disk ?? ""] as const)
      : Promise.all([
          readFileAtRev(workspacePath, `${selected.hash}^`, selected.path),
          readFileAtCommit(workspacePath, selected),
        ]).then(([base, version]) => [base ?? "", version] as const);
    load
      .then(([base, version]) => {
        if (cancelled) return;
        setBaseContent(base);
        setSelectedContent(version);
      })
      .catch((e) => !cancelled && setDiffError(errMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [workspacePath, selected, path]);

  const requestRollback = () => {
    if (!selected || selectedContent === null || isWorkingCommit(selected)) return;
    openConfirm({
      title: tr("回退版本"),
      message:
        tr("将把「{{0}}」恢复为 {{1}}", { 0: basename(path), 1: selected.shortHash }) +
        tr("（{{0}}）的内容。", { 0: formatRelTime(selected.timestamp) }) +
        tr("回退会作为未提交更改保留，请通过同步提交；若当前有未提交更改，请先同步。"),
      confirmLabel: tr("回退"),
      tone: "primary",
      onConfirm: () => rollbackToVersion(selected, selectedContent),
    });
  };

  const requestDiscardWorking = () => {
    if (!workingFile) return;
    openConfirm({
      title: tr("撤销未提交更改"),
      message:
        tr("将丢弃「{{0}}」尚未提交的更改，恢复到上次提交（HEAD）的状态。", { 0: basename(path) }) +
        tr("此操作不可恢复。"),
      confirmLabel: tr("撤销"),
      onConfirm: async () => {
        await discardHistoryChanges([workingFile]);
        setReloadToken((v) => v + 1);
      },
    });
  };

  const sameAsCurrent =
    selectedContent !== null && content !== null && selectedContent === content;
  // The working entry IS the current state — nothing to roll back to.
  const workingSelected = selected !== null && isWorkingCommit(selected);
  const rollbackDisabled =
    !selected || selectedContent === null || sameAsCurrent || workingSelected;
  const primaryDisabled = workingSelected ? !workingFile : rollbackDisabled;
  // Both commit and working entries now drive the right side from loaded state
  // (working = the on-disk file, commit = that commit's version).
  const diffNewContent = selectedContent;

  return (
    <>
      {error ? (
        <CenterNote color="var(--danger, #e5484d)">{error}</CenterNote>
      ) : commits === null ? (
        <CenterNote>{tr("加载历史…")}</CenterNote>
      ) : commits.length === 0 ? (
        <CenterNote>{tr("该文件还没有提交记录")}</CenterNote>
      ) : (
        <div className="flex min-h-0 flex-1">
          <CommitList commits={commits} selected={selected} onSelect={setSelected} />

          {/* diff pane */}
          <div className="flex min-w-0 flex-1 flex-col">
            <div
              className="flex h-9 shrink-0 items-center gap-2 px-3 text-[11px]"
              style={{ borderBottom: "1px solid var(--border)", color: "var(--text-muted)" }}
            >
              <span className="min-w-0 flex-1 truncate">
                {workingSelected
                  ? tr("上次提交（HEAD） / 当前内容")
                  : tr("上一版本 / 选中版本（{{0}}）", { 0: selected ? selected.shortHash : "—" })}
              </span>
              <HistoryActionButton
                onClick={workingSelected ? requestDiscardWorking : requestRollback}
                disabled={primaryDisabled}
                tone={workingSelected ? "danger" : "primary"}
                title={
                  workingSelected
                    ? tr("丢弃这个文件尚未提交的更改")
                    : sameAsCurrent
                      ? tr("与当前内容一致")
                      : undefined
                }
              >
                {workingSelected ? tr("撤销未提交更改") : tr("回退到此版本")}
              </HistoryActionButton>
            </div>
            {diffError || currentError ? (
              <CenterNote color="var(--danger, #e5484d)">
                {diffError ?? currentError}
              </CenterNote>
            ) : baseContent === null || diffNewContent === null ? (
              <CenterNote>{tr("加载版本内容…")}</CenterNote>
            ) : (
              <DiffView oldText={baseContent} newText={diffNewContent} path={path} />
            )}
          </div>
        </div>
      )}
    </>
  );
}

/* --------------------------- folder / project --------------------------- */

const STATUS_LABEL: Record<string, string> = {
  get A() { return tr("新增"); },
  get M() { return tr("修改"); },
  get D() { return tr("删除"); },
  get R() { return tr("改名"); },
  get C() { return tr("复制"); },
  get U() { return tr("冲突"); },
};

const STATUS_COLOR: Record<string, string> = {
  A: "var(--file-image)",
  M: "var(--note-icon)",
  D: "var(--danger, #e5484d)",
  R: "var(--file-config)",
  C: "var(--file-config)",
  U: "var(--danger, #e5484d)",
};

function DirHistoryDialog({ path }: { path: string }) {
  useLanguage();
  const workspacePath = useAppStore((s) => s.workspacePath);
  const closeHistory = useAppStore((s) => s.closeHistory);

  const relPath = workspacePath ? relativePathWithinWorkspace(workspacePath, path) : null;
  const title = relPath
    ? tr("文件夹历史 — {{0}}", { 0: basename(path) })
    : tr("全局历史 — {{0}}", { 0: basename(path) });

  return (
    <HistoryShell title={title} onClose={closeHistory}>
      <DirHistoryContent path={path} />
    </HistoryShell>
  );
}

function DirHistoryContent({ path }: { path: string }) {
  useLanguage();
  const workspacePath = useAppStore((s) => s.workspacePath);
  if (!workspacePath) return <CenterNote>{tr("还没有打开工作区")}</CenterNote>;
  const relPath = relativePathWithinWorkspace(workspacePath, path);
  if (relPath === null) return <CenterNote>{tr("此文件夹不属于当前项目，无法查看项目内的历史记录。")}</CenterNote>;
  return <ScopedDirHistoryContent key={JSON.stringify([workspacePath, path])}
    workspacePath={workspacePath} relPath={relPath} />;
}

function ScopedDirHistoryContent({ workspacePath, relPath }: { workspacePath: string; relPath: string }) {
  useLanguage();
  const openConfirm = useAppStore((s) => s.openConfirm);
  const rollbackWorkspaceToVersion = useAppStore((s) => s.rollbackWorkspaceToVersion);
  const discardHistoryChanges = useAppStore((s) => s.discardHistoryChanges);

  const [commits, setCommits] = useState<FileCommit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<FileCommit | null>(null);
  const [workingFiles, setWorkingFiles] = useState<CommitFile[]>([]);
  const [files, setFiles] = useState<CommitFile[] | null>(null);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<CommitFile | null>(null);
  const [diff, setDiff] = useState<{ oldText: string; newText: string } | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  // Commit list, once per open; uncommitted changes become a pseudo-entry
  // at the top.
  useEffect(() => {
    if (!workspacePath) return;
    let cancelled = false;
    Promise.all([
      listDirHistory(workspacePath, relPath),
      listWorkingChanges(workspacePath, relPath).catch(() => []),
    ])
      .then(([list, working]) => {
        if (cancelled) return;
        setWorkingFiles(working);
        const all =
          working.length > 0
            ? [workingEntry(relPath, tr("未提交的更改（{{0}} 个文件）", { 0: working.length })), ...list]
            : list;
        setCommits(all);
        setSelected(all[0] ?? null);
      })
      .catch((e) => !cancelled && setError(errMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [workspacePath, relPath, reloadToken]);

  // Changed-file list of the selected commit (precomputed for the working entry).
  useEffect(() => {
    if (!workspacePath || !selected) return;
    let cancelled = false;
    setFiles(null);
    setFilesError(null);
    setSelectedFile(null);
    setDiff(null);
    setDiffError(null);
    if (isWorkingCommit(selected)) {
      setFiles(workingFiles);
      setSelectedFile(workingFiles[0] ?? null);
      return;
    }
    listCommitFiles(workspacePath, selected.hash, relPath)
      .then((list) => {
        if (cancelled) return;
        setFiles(list);
        setSelectedFile(list[0] ?? null);
      })
      .catch((e) => !cancelled && setFilesError(errMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [workspacePath, selected, relPath, workingFiles]);

  // Per-file diff. Commits: parent version vs commit version. Working entry:
  // HEAD version vs the file on disk.
  useEffect(() => {
    if (!workspacePath || !selected || !selectedFile) return;
    if (isImageFile(selectedFile.path)) return; // handled in render
    let cancelled = false;
    setDiff(null);
    setDiffError(null);
    const sides = isWorkingCommit(selected)
      ? Promise.all([
          readFileAtRev(workspacePath, "HEAD", selectedFile.oldPath ?? selectedFile.path),
          // CommitFile paths are repo-root-relative; the workspace may sit
          // deeper, so resolve against the repo root. Read failure = deleted.
          getRepoRoot(workspacePath)
            .then((root) => readFile(`${root}/${selectedFile.path}`))
            .catch(() => null),
        ])
      : Promise.all([
          readFileAtRev(
            workspacePath,
            `${selected.hash}^`,
            selectedFile.oldPath ?? selectedFile.path,
          ),
          readFileAtRev(workspacePath, selected.hash, selectedFile.path),
        ]);
    sides
      .then(([oldText, newText]) => {
        // Missing side = file added / deleted there; diff against empty.
        if (!cancelled) setDiff({ oldText: oldText ?? "", newText: newText ?? "" });
      })
      .catch((e) => !cancelled && setDiffError(errMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [workspacePath, selected, selectedFile]);

  const workingSelected = selected !== null && isWorkingCommit(selected);
  const isGlobalHistory = relPath === "";
  const latestCommit = commits?.find((c) => !isWorkingCommit(c)) ?? null;
  const selectedIsLatestCommit =
    !!selected && !!latestCommit && selected.hash === latestCommit.hash;
  const showRollbackWorkspace = isGlobalHistory && !!selected && !workingSelected;
  const canRollbackWorkspace =
    showRollbackWorkspace && !selectedIsLatestCommit;

  const requestRollbackWorkspace = () => {
    if (!selected || !canRollbackWorkspace) return;
    openConfirm({
      title: tr("回退项目版本"),
      message:
        tr("将把整个项目恢复为 {{0}}（{{1}}）的内容。", { 0: selected.shortHash, 1: formatRelTime(selected.timestamp) }) +
        tr("回退会作为未提交更改保留，请通过同步提交；不会改写已有历史。"),
      confirmLabel: tr("回退"),
      tone: "primary",
      onConfirm: () => rollbackWorkspaceToVersion(selected),
    });
  };

  const requestDiscardFiles = (targets: CommitFile[], label: string) => {
    if (targets.length === 0) return;
    openConfirm({
      title: tr("撤销未提交更改"),
      message:
        tr("将丢弃{{0}}尚未提交的更改，恢复到上次提交（HEAD）的状态。", { 0: label }) +
        tr("此操作不可恢复。"),
      confirmLabel: tr("撤销"),
      onConfirm: async () => {
        await discardHistoryChanges(targets);
        setReloadToken((v) => v + 1);
      },
    });
  };

  return (
    <>
      {error ? (
        <CenterNote color="var(--danger, #e5484d)">{error}</CenterNote>
      ) : commits === null ? (
        <CenterNote>{tr("加载历史…")}</CenterNote>
      ) : commits.length === 0 ? (
        <CenterNote>{tr("还没有提交记录")}</CenterNote>
      ) : (
        <div className="flex min-h-0 flex-1">
          <CommitList commits={commits} selected={selected} onSelect={setSelected} />

          {/* changed files of the commit */}
          <div
            className="flex w-64 shrink-0 flex-col overflow-y-auto py-1"
            style={{ borderRight: "1px solid var(--border)" }}
          >
            {filesError ? (
              <CenterNote color="var(--danger, #e5484d)">{filesError}</CenterNote>
            ) : files === null ? (
              <CenterNote>{tr("加载文件列表…")}</CenterNote>
            ) : files.length === 0 ? (
              <CenterNote>{tr("该提交没有文件变更")}</CenterNote>
            ) : (
              files.map((f) => {
                const active = selectedFile?.path === f.path;
                const dir = f.path.includes("/")
                  ? f.path.slice(0, f.path.lastIndexOf("/"))
                  : "";
                return (
                  <button
                    key={f.path}
                    onClick={() => setSelectedFile(f)}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left"
                    style={{ background: active ? "var(--active)" : "transparent" }}
                    onMouseEnter={(e) => {
                      if (!active) e.currentTarget.style.background = "var(--hover)";
                    }}
                    onMouseLeave={(e) => {
                      if (!active) e.currentTarget.style.background = "transparent";
                    }}
                    title={
                      f.oldPath ? `${f.oldPath} → ${f.path}` : f.path
                    }
                  >
                    <span
                      className="w-7 shrink-0 text-center font-mono text-[10.5px] font-medium"
                      style={{ color: STATUS_COLOR[f.status] ?? "var(--text-muted)" }}
                    >
                      {STATUS_LABEL[f.status] ?? f.status}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span
                        className="block truncate text-[12.5px]"
                        style={{ color: "var(--text)" }}
                      >
                        {basename(f.path)}
                      </span>
                      {dir && (
                        <span
                          className="block truncate text-[10.5px]"
                          style={{ color: "var(--text-muted)" }}
                        >
                          {dir}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })
            )}
          </div>

          {/* per-file diff */}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="shrink-0" style={{ borderBottom: "1px solid var(--border)" }}>
              <div
                className="flex h-9 items-center gap-2 px-3 text-[11px]"
                style={{ color: "var(--text-muted)" }}
              >
                <span className="min-w-0 flex-1 truncate">
                  {!selectedFile
                    ? tr("选择左侧文件查看差异")
                    : workingSelected
                      ? tr("{{0}} — 未提交的更改，与上次提交（HEAD）对比", { 0: basename(selectedFile.path) })
                      : tr("{{0}} — {{1}} 与上一版本对比", { 0: basename(selectedFile.path), 1: selected?.shortHash })}
                </span>
                {showRollbackWorkspace && (
                  <HistoryActionButton
                    onClick={requestRollbackWorkspace}
                    disabled={!canRollbackWorkspace}
                    tone="primary"
                    title={
                      selectedIsLatestCommit
                        ? tr("已经是当前版本")
                        : tr("恢复整个项目到此提交的内容，不改写历史")
                    }
                  >
                    {tr("回退到此版本")}</HistoryActionButton>
                )}
              </div>
              {workingSelected && (
                <div
                  className="flex h-8 items-center justify-end gap-1.5 px-3"
                  style={{ borderTop: "1px solid var(--border)" }}
                >
                  <HistoryActionButton
                    onClick={() => selectedFile && requestDiscardFiles([selectedFile], `「${basename(selectedFile.path)}」`)}
                    disabled={!selectedFile}
                    tone="danger"
                    title={tr("撤销此文件尚未提交的更改")}
                  >
                    {tr("撤销此文件")}</HistoryActionButton>
                  <HistoryActionButton
                    onClick={() => requestDiscardFiles(workingFiles, tr("全部 {{0}} 个文件", { 0: workingFiles.length }))}
                    disabled={workingFiles.length === 0}
                    title={tr("撤销全部未提交更改")}
                  >
                    {tr("撤销全部")}</HistoryActionButton>
                </div>
              )}
            </div>
            {!selectedFile ? (
              <CenterNote>{tr("该提交没有可显示的文件")}</CenterNote>
            ) : isImageFile(selectedFile.path) ? (
              <CenterNote>{tr("图片等二进制文件无法显示差异")}</CenterNote>
            ) : diffError ? (
              <CenterNote color="var(--danger, #e5484d)">{diffError}</CenterNote>
            ) : diff === null ? (
              <CenterNote>{tr("加载差异…")}</CenterNote>
            ) : (
              <DiffView oldText={diff.oldText} newText={diff.newText} path={selectedFile.path} />
            )}
          </div>
        </div>
      )}
    </>
  );
}

/** Read-only side-by-side diff: old version (a, red) vs new (b, green). */
function DiffView({
  oldText,
  newText,
  path,
}: {
  oldText: string;
  newText: string;
  path: string;
}) {
  useLanguage();
  const ref = useRef<HTMLDivElement>(null);
  const markdownFile = isMarkdownFile(path);
  const [languageExt, setLanguageExt] = useState<Extension[]>(() =>
    markdownFile
      ? [
          markdown({
            base: markdownLanguage,
            codeLanguages: languages,
            extensions: [GFM, inlineMath],
          }),
        ]
      : [],
  );

  useEffect(() => {
    let cancelled = false;
    if (markdownFile) {
      setLanguageExt([
        markdown({
          base: markdownLanguage,
          codeLanguages: languages,
          extensions: [GFM, inlineMath],
        }),
      ]);
      return () => {
        cancelled = true;
      };
    }

    setLanguageExt([]);
    const desc = LanguageDescription.matchFilename(languages, basename(path));
    if (!desc) {
      return () => {
        cancelled = true;
      };
    }
    desc
      .load()
      .then((lang) => {
        if (!cancelled) setLanguageExt([lang]);
      })
      .catch(() => {
        if (!cancelled) setLanguageExt([]);
      });
    return () => {
      cancelled = true;
    };
  }, [markdownFile, path]);

  useEffect(() => {
    if (!ref.current) return;
    const readOnly = [
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      EditorView.editorAttributes.of({
        class: markdownFile ? "cm-history-markdown" : "cm-history-code",
      }),
      lineNumbers(),
      EditorView.lineWrapping,
      cmHighlighting,
      cmHistoryDiffTheme,
      ...languageExt,
    ];
    const view = new MergeView({
      parent: ref.current,
      a: { doc: oldText, extensions: readOnly },
      b: { doc: newText, extensions: readOnly },
      gutter: true,
      collapseUnchanged: { margin: 3, minSize: 4 },
    });
    return () => view.destroy();
  }, [oldText, newText, markdownFile, languageExt]);
  return <div ref={ref} className="cm-history-diff min-h-0 flex-1 overflow-auto" />;
}
