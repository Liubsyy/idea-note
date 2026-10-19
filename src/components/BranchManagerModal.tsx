import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Cloud, GitBranch as BranchIcon, Pencil, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { tr } from "../i18n/core.ts";
import { useLanguage } from "../i18n/react";
import { useAppStore } from "../store/useAppStore";
import { createBranch, deleteBranch, listBranches, renameBranch, switchBranch, type GitBranch } from "../lib/gitBranches";

type BranchForm = { name: string; base: string; switchAfter: boolean; previous: string | null };

export function BranchManagerModal() {
  const open = useAppStore((s) => s.branchManagerOpen);
  const workspacePath = useAppStore((s) => s.workspacePath);
  const setOpen = useAppStore((s) => s.setBranchManagerOpen);
  const previous = useRef(workspacePath);
  useEffect(() => {
    if (previous.current !== workspacePath) setOpen(false);
    previous.current = workspacePath;
  }, [workspacePath, setOpen]);
  if (!open || !workspacePath) return null;
  return <BranchManagerDialog key={workspacePath} workspacePath={workspacePath} />;
}

function BranchManagerDialog({ workspacePath }: { workspacePath: string }) {
  useLanguage();
  const busy = useAppStore((s) => s.branchTaskBusy);
  const confirm = useAppStore((s) => s.confirm);
  const isDirty = useAppStore((s) => s.isDirty);
  const setOpen = useAppStore((s) => s.setBranchManagerOpen);
  const [snapshot, setSnapshot] = useState<Awaited<ReturnType<typeof listBranches>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<BranchForm | null>(null);
  const mounted = useRef(true);
  const request = useRef(0);
  const reload = useCallback(async () => {
    const id = ++request.current;
    try {
      const result = await listBranches(workspacePath);
      if (mounted.current && request.current === id) setSnapshot(result);
    } catch (cause) {
      if (mounted.current && request.current === id) setError(String(cause instanceof Error ? cause.message : cause));
    }
  }, [workspacePath]);
  useEffect(() => {
    mounted.current = true;
    void reload();
    return () => { mounted.current = false; };
  }, [reload]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || confirm || useAppStore.getState().confirm || busy) return;
      if (form) setForm(null);
      else setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, confirm, form, setOpen]);

  const dirty = !!snapshot?.dirty || isDirty;
  const execute = async (task: (dir: string) => Promise<boolean>, message: string) => {
    setError(null);
    try {
      if (useAppStore.getState().workspacePath !== workspacePath) return;
      await useAppStore.getState().runBranchTask(task);
      if (!mounted.current) return;
      setForm(null);
      await reload();
      useAppStore.getState().showToast(message);
    } catch (cause) {
      if (mounted.current) {
        setError(cause instanceof Error ? cause.message : String(cause));
        await reload();
      }
      throw cause;
    }
  };
  const changeBranch = (branch: GitBranch) => {
    void execute(async (dir) => { await switchBranch(dir, branch.ref); return true; }, tr("分支已切换")).catch(() => {});
  };
  const requestDelete = (branch: GitBranch) => {
    useAppStore.getState().openConfirm({
      title: tr("删除本地分支"),
      message: tr("确定删除本地分支「{{0}}」？仅支持删除已合并到当前分支的分支。", { 0: branch.name }),
      confirmLabel: tr("删除"),
      onConfirm: () => execute(async (dir) => { await deleteBranch(dir, branch.name); return false; }, tr("分支已删除")),
    });
  };
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!form || busy) return;
    const current = form;
    void execute(async (dir) => {
      if (current.previous) await renameBranch(dir, current.previous, current.name);
      else await createBranch(dir, current.name, current.base, current.switchAfter);
      return !current.previous && current.switchAfter;
    }, current.previous ? tr("分支已重命名") : tr("分支已创建")).catch(() => {});
  };
  const action = "flex items-center justify-center gap-1 rounded-md px-2 py-1 text-xs hover:bg-[var(--hover)] disabled:cursor-default disabled:opacity-35";

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-start justify-center backdrop-blur-sm" style={{ background: "rgba(0,0,0,0.32)" }} onMouseDown={() => { if (!busy) setOpen(false); }}>
      <div role="dialog" aria-modal="true" aria-label={tr("分支管理")} className="mt-24 flex max-h-[calc(100vh-128px)] w-[620px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-xl text-sm" style={{ background: "var(--bg-elev)", color: "var(--text)", border: "1px solid var(--border)", boxShadow: "0 18px 54px var(--shadow)" }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex shrink-0 items-center gap-2 px-4 py-3" style={{ borderBottom: "1px solid var(--border)" }}>
          <BranchIcon size={17} />
          <span className="flex-1 font-semibold">{tr("分支管理")}</span>
          <button type="button" disabled={busy} title={tr("刷新")} aria-label={tr("刷新")} className={action} onClick={() => { setError(null); void reload(); }}><RefreshCw size={15} /></button>
          <button type="button" disabled={busy} title={tr("关闭")} aria-label={tr("关闭")} className={action} onClick={() => setOpen(false)}><X size={17} /></button>
        </div>
        <div className="min-h-0 overflow-y-auto px-4 py-3">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <span style={{ color: "var(--text-muted)" }}>{tr("当前分支")} <span className="ml-1 font-medium" style={{ color: "var(--text)" }}>{snapshot?.current === "HEAD" ? tr("分离的 HEAD") : snapshot?.current ?? "—"}</span></span>
            <button type="button" disabled={busy} className={`${action} border`} style={{ borderColor: "var(--border)", color: "var(--accent)" }} onClick={() => setForm({ name: "", base: "HEAD", switchAfter: true, previous: null })}><Plus size={14} />{tr("新建分支")}</button>
          </div>
          {error && <p role="alert" className="my-2 text-xs" style={{ color: "var(--ansi-red)" }}>{error}</p>}
          {dirty && <div className="mb-3 flex flex-wrap items-center gap-2 text-xs" style={{ color: "var(--ansi-red)" }}>
            <span>{tr("有未提交的更改，请先提交或撤销，再切换分支")}</span>
            <button type="button" disabled={busy} className="underline" onClick={() => { setOpen(false); useAppStore.getState().setManualSyncOpen(true); }}>{tr("手动同步…")}</button>
          </div>}
          {form && <form className="mb-3 rounded-lg p-3" style={{ background: "var(--bg)", border: "1px solid var(--border)" }} onSubmit={submit}>
            <div className="mb-2 font-medium">{form.previous ? tr("重命名") : tr("新建分支")}</div>
            <label className="mb-2 block text-xs">{tr("分支名称")}
              <input autoFocus required disabled={busy} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="feature/reading" className="mt-1 block w-full rounded-md px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-[var(--accent)]" style={{ background: "var(--bg-elev)", border: "1px solid var(--border)" }} />
            </label>
            {!form.previous && <>
              <label className="block text-xs">{tr("起点")}<select disabled={busy} className="mt-1 block w-full rounded-md px-2 py-1.5 text-sm" style={{ background: "var(--bg-elev)", border: "1px solid var(--border)" }} value={form.base} onChange={(e) => setForm({ ...form, base: e.target.value })}>
                <option value="HEAD">{tr("当前提交（HEAD）")}</option>
                {snapshot?.branches.map((branch) => <option key={branch.ref} value={branch.ref}>{branch.remote ? tr("远程分支") : tr("本地分支")} · {branch.name}</option>)}
              </select></label>
              <label className="mt-2 flex items-center gap-2 text-xs"><input type="checkbox" disabled={busy} checked={form.switchAfter} onChange={(e) => setForm({ ...form, switchAfter: e.target.checked })} style={{ accentColor: "var(--accent)" }} />{tr("创建后切换到新分支")}</label>
            </>}
            <div className="mt-3 flex justify-end gap-2">
              <button type="button" disabled={busy} className={action} onClick={() => setForm(null)}>{tr("取消")}</button>
              <button type="submit" disabled={busy || !form.name.trim() || (!form.previous && form.switchAfter && dirty)} className={`${action} text-white`} style={{ background: "var(--accent)" }}>{form.previous ? tr("保存") : tr("新建")}</button>
            </div>
          </form>}
          {!snapshot ? <p className="py-5 text-center" style={{ color: "var(--text-muted)" }}>{tr("加载分支…")}</p> : snapshot.branches.length === 0 ? <p className="py-5 text-center" style={{ color: "var(--text-muted)" }}>{tr("分支列表为空，请先完成一次提交")}</p> : [false, true].map((remote) => {
            const branches = snapshot.branches.filter((branch) => branch.remote === remote).sort((a, b) => Number(b.current) - Number(a.current) || a.name.localeCompare(b.name));
            return branches.length > 0 && <section key={String(remote)}>
              <div className="mb-1 mt-4 text-xs" style={{ color: "var(--text-muted)" }}>{remote ? tr("远程分支") : tr("本地分支")}</div>
              {branches.map((branch) => <div key={branch.ref} className="flex flex-wrap items-center gap-2 py-2.5" style={{ borderBottom: "1px solid var(--border)" }}>
                {remote ? <Cloud size={15} /> : <BranchIcon size={15} />}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2"><span className="break-all">{branch.name}</span>{branch.current && <span className="shrink-0 text-[11px]" style={{ color: "var(--accent)" }}>{tr("当前")}</span>}</div>
                  <div className="mt-0.5 truncate text-xs" title={branch.subject} style={{ color: "var(--text-muted)" }}>{branch.hash} · {branch.subject}</div>
                  {branch.upstream && <div className="truncate text-[11px]" style={{ color: "var(--text-muted)" }}>→ {branch.upstream.replace(/^refs\/remotes\//, "")}</div>}
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  <button type="button" className={action} disabled={busy || dirty || branch.current || !!(!remote && branch.worktree)} onClick={() => changeBranch(branch)}>{remote ? tr("检出") : tr("切换")}</button>
                  {!remote && <>
                    <button type="button" className={action} disabled={busy || !!(branch.worktree && !branch.current)} aria-label={tr("重命名")} title={tr("重命名")} onClick={() => setForm({ name: branch.name, base: "HEAD", switchAfter: false, previous: branch.name })}><Pencil size={14} /></button>
                    <button type="button" className={action} style={{ color: "var(--ansi-red)" }} disabled={busy || branch.current || !!branch.worktree} aria-label={tr("删除")} title={tr("删除本地分支")} onClick={() => requestDelete(branch)}><Trash2 size={14} /></button>
                  </>}
                </div>
              </div>)}
            </section>;
          })}
        </div>
        <div className="shrink-0 px-4 py-2 text-xs" style={{ borderTop: "1px solid var(--border)", color: "var(--text-muted)" }}>{tr("窗口打开期间暂停自动同步")} · {tr("远程分支来自最近一次同步")}</div>
      </div>
    </div>, document.body,
  );
}
