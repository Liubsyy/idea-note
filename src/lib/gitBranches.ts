import { tr } from "../i18n/core.ts";
import { friendlyGitError, getCurrentBranch, getRepoRoot, GitError, gitRun } from "./git";

export interface GitBranch {
  ref: string;
  name: string;
  remote: boolean;
  current: boolean;
  hash: string;
  subject: string;
  upstream: string;
  worktree: string;
}

async function checked(dir: string, args: string[]) {
  const result = await gitRun(dir, args);
  if (result.code !== 0) throw new GitError(friendlyGitError(result.stderr), result.stderr);
  return result.stdout;
}

async function branchName(root: string, input: string): Promise<string> {
  const name = input.trim();
  if (!name || name.startsWith("-") || name === "HEAD" ||
    (await gitRun(root, ["check-ref-format", `refs/heads/${name}`])).code !== 0) {
    throw new Error(tr("分支名称无效，请勿使用空格或 Git 特殊字符"));
  }
  return name;
}

async function existingRef(root: string, ref: string): Promise<void> {
  if (!/^refs\/(heads|remotes)\/.+/.test(ref) ||
    (await gitRun(root, ["show-ref", "--verify", "--quiet", ref])).code !== 0) {
    throw new Error(tr("分支已不存在，请刷新列表"));
  }
}

async function cleanTree(root: string): Promise<void> {
  if ((await checked(root, ["status", "--porcelain", "-z", "--untracked-files=all"])).length) {
    throw new Error(tr("有未提交的更改，请先提交或撤销，再切换分支"));
  }
}

export async function listBranches(dir: string): Promise<{ branches: GitBranch[]; current: string; dirty: boolean }> {
  const root = await getRepoRoot(dir);
  const [refs, current, status] = await Promise.all([
    checked(root, ["for-each-ref", "--sort=refname", "--format=%(refname)%00%(objectname:short)%00%(subject)%00%(upstream)%00%(worktreepath)%00%(symref)", "refs/heads", "refs/remotes"]),
    getCurrentBranch(root),
    checked(root, ["status", "--porcelain", "-z", "--untracked-files=all"]),
  ]);
  const branches = refs.split("\n").filter(Boolean).flatMap((line): GitBranch[] => {
    const [ref, hash, subject, upstream, worktree, symref] = line.split("\0");
    if (symref) return []; // origin/HEAD is an alias, not a branch.
    const remote = ref.startsWith("refs/remotes/");
    const name = ref.slice(remote ? "refs/remotes/".length : "refs/heads/".length);
    return [{ ref, name, remote, hash, subject, upstream, worktree, current: !remote && name === current }];
  });
  return { branches, current: current ?? "HEAD", dirty: status.length > 0 };
}

/** Switch only from a clean working tree; never stash, commit, or overwrite edits. */
export async function switchBranch(dir: string, ref: string): Promise<void> {
  const root = await getRepoRoot(dir);
  await existingRef(root, ref);
  await cleanTree(root);
  if (ref.startsWith("refs/heads/")) {
    await checked(root, ["switch", "--no-guess", ref.slice("refs/heads/".length)]);
    return;
  }
  const remoteName = ref.slice("refs/remotes/".length);
  const name = await branchName(root, remoteName.slice(remoteName.indexOf("/") + 1));
  const local = `refs/heads/${name}`;
  if ((await gitRun(root, ["show-ref", "--verify", "--quiet", local])).code === 0) {
    const upstream = (await checked(root, ["for-each-ref", "--format=%(upstream)", local])).trim();
    if (upstream !== ref) throw new Error(tr("同名本地分支已存在，请从本地列表切换或使用其他名称新建"));
    await checked(root, ["switch", "--no-guess", name]);
  } else {
    await checked(root, ["switch", "--track", "-c", name, ref]);
  }
}

export async function createBranch(dir: string, input: string, base = "HEAD", switchAfter = true): Promise<void> {
  const root = await getRepoRoot(dir);
  const name = await branchName(root, input);
  if (base !== "HEAD") await existingRef(root, base);
  if ((await gitRun(root, ["rev-parse", "--verify", `${base}^{commit}`])).code !== 0) {
    throw new Error(tr("请先完成一次提交，再创建分支"));
  }
  if (switchAfter) await cleanTree(root);
  const tracking = base.startsWith("refs/remotes/") ? "--track" : "--no-track";
  await checked(root, switchAfter
    ? ["switch", tracking, "-c", name, base]
    : ["branch", tracking, name, base]);
}

export async function renameBranch(dir: string, previous: string, input: string): Promise<void> {
  const root = await getRepoRoot(dir);
  const oldName = await branchName(root, previous);
  const name = await branchName(root, input);
  await existingRef(root, `refs/heads/${oldName}`);
  await checked(root, ["branch", "-m", oldName, name]);
}

/** Only branches already merged into the current HEAD may be deleted. */
export async function deleteBranch(dir: string, input: string): Promise<void> {
  const root = await getRepoRoot(dir);
  const name = await branchName(root, input);
  const ref = `refs/heads/${name}`;
  await existingRef(root, ref);
  if (await getCurrentBranch(root) === name) throw new Error(tr("不能删除当前分支，请先切换到其他分支"));
  if ((await gitRun(root, ["merge-base", "--is-ancestor", ref, "HEAD"])).code !== 0) {
    throw new Error(tr("这个分支尚未合并到当前分支，暂不支持强制删除"));
  }
  await checked(root, ["branch", "-d", name]);
}
