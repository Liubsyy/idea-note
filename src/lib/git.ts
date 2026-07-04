// Git-based sync. Everything shells out to the user's git CLI via the
// `git_run` Rust command; orchestration (attach / clone / sync) lives here so
// the UI can give step-level feedback. Conflicts are resolved by keeping both
// sides' conflict markers in the file and completing the merge commit, so a
// sync never blocks and never loses data. Without a remote, sync degrades to
// local-only commits — periodic snapshots into the local repo.

import { invoke } from "@tauri-apps/api/core";

export interface GitOutput {
  code: number;
  stdout: string;
  stderr: string;
}

/** Raw git invocation. Non-zero exit codes come back as a normal GitOutput;
 *  the promise only rejects when git itself can't run (not installed, bad dir). */
export const gitRun = (dir: string, args: string[]) =>
  invoke<GitOutput>("git_run", { dir, args });

export class GitError extends Error {
  /** Raw stderr of the failing command, for detail display. */
  readonly stderr: string;
  constructor(message: string, stderr = "") {
    super(message);
    this.name = "GitError";
    this.stderr = stderr;
  }
}

/** Map common git stderr patterns to a readable Chinese message. */
export function friendlyGitError(stderr: string): string {
  const s = stderr.toLowerCase();
  if (
    s.includes("authentication failed") ||
    s.includes("permission denied") ||
    s.includes("could not read username") ||
    s.includes("could not read password") ||
    s.includes("host key verification failed")
  ) {
    return "认证失败：请配置 SSH key 或 git credential helper 后重试";
  }
  if (
    s.includes("could not resolve host") ||
    s.includes("unable to access") ||
    s.includes("connection timed out") ||
    s.includes("connection refused") ||
    s.includes("network is unreachable")
  ) {
    return "无法连接远程仓库，请检查网络";
  }
  if (s.includes("not a git repository")) {
    return "当前文件夹尚未关联 git 仓库";
  }
  if (s.includes("repository not found") || s.includes("does not appear to be a git repository")) {
    return "远程仓库不存在，请检查地址";
  }
  const firstLine = stderr.trim().split("\n")[0] ?? "";
  return firstLine ? `git 操作失败：${firstLine}` : "git 操作失败";
}

/** Run git and throw a friendly GitError on non-zero exit. */
async function gitOk(dir: string, args: string[]): Promise<GitOutput> {
  const out = await gitRun(dir, args);
  if (out.code !== 0) throw new GitError(friendlyGitError(out.stderr), out.stderr);
  return out;
}

/**
 * Prepend a per-invocation proxy via `git -c http.proxy=…`, used only for the
 * commands that touch the network (fetch/push/clone). This never writes to any
 * git config file, so the proxy applies only while syncing — not globally.
 */
function withProxy(proxy: string | undefined, args: string[]): string[] {
  const p = proxy?.trim();
  if (!p) return args;
  return ["-c", `http.proxy=${p}`, "-c", `https.proxy=${p}`, ...args];
}

/* ------------------------------- queries ------------------------------- */

export interface GitInfo {
  /** False only when the git binary itself is missing. */
  installed: boolean;
  isRepo: boolean;
  remoteUrl: string | null;
  branch: string | null;
}

export async function isGitRepo(dir: string): Promise<boolean> {
  const out = await gitRun(dir, ["rev-parse", "--is-inside-work-tree"]);
  return out.code === 0 && out.stdout.trim() === "true";
}

export async function getRemoteUrl(dir: string): Promise<string | null> {
  const out = await gitRun(dir, ["remote", "get-url", "origin"]);
  return out.code === 0 ? out.stdout.trim() : null;
}

/** Current branch name; works for an unborn HEAD (fresh repo, no commits). */
export async function getCurrentBranch(dir: string): Promise<string | null> {
  const out = await gitRun(dir, ["symbolic-ref", "--short", "HEAD"]);
  if (out.code === 0) return out.stdout.trim();
  const abbrev = await gitRun(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return abbrev.code === 0 ? abbrev.stdout.trim() : null;
}

/** One-shot status snapshot for the settings page / title bar. */
export async function getGitInfo(dir: string): Promise<GitInfo> {
  try {
    const isRepo = await isGitRepo(dir);
    if (!isRepo) return { installed: true, isRepo: false, remoteUrl: null, branch: null };
    const [remoteUrl, branch] = await Promise.all([getRemoteUrl(dir), getCurrentBranch(dir)]);
    return { installed: true, isRepo: true, remoteUrl, branch };
  } catch {
    // invoke rejected — git binary missing (or dir vanished).
    return { installed: false, isRepo: false, remoteUrl: null, branch: null };
  }
}

/* ------------------------------- history ------------------------------- */

export interface FileCommit {
  hash: string; // %H
  shortHash: string; // %h
  author: string; // %an
  /** Commit time in milliseconds. */
  timestamp: number; // %at * 1000
  subject: string; // %s
  /** Repo-root-relative path of the file AT this commit (--follow renames). */
  path: string;
}

/**
 * Per-file commit log, following renames. `relPath` is relative to `dir`
 * (the workspace), which may itself be a subfolder of the repo — the `./`
 * pathspec prefix makes git resolve it against cwd, not the repo root.
 */
export async function listFileHistory(dir: string, relPath: string): Promise<FileCommit[]> {
  const out = await gitRun(dir, [
    // Keep CJK filenames readable instead of octal-escaped.
    "-c",
    "core.quotepath=false",
    "log",
    "--follow",
    // Older commits know the file under its old name; --name-only prints the
    // path as of each commit (repo-root-relative) so `show rev:path` works.
    "--name-only",
    // \x01 separates records (subjects may contain tabs/newlines); \t separates
    // the fixed fields, with the free-form subject last.
    "--format=%x01%H%x09%h%x09%an%x09%at%x09%s",
    "--",
    "./" + relPath.replace(/\\/g, "/"),
  ]);
  if (out.code !== 0) {
    // Fresh repo with an unborn HEAD simply has no history yet.
    if (/does not have any commits yet|bad default revision|unknown revision/i.test(out.stderr))
      return [];
    throw new GitError(friendlyGitError(out.stderr), out.stderr);
  }

  const commits: FileCommit[] = [];
  for (const record of out.stdout.split("\x01")) {
    if (!record.trim()) continue;
    const lines = record.split("\n");
    const [hash, shortHash, author, at, ...rest] = lines[0].split("\t");
    if (!hash || !shortHash) continue;
    // Merge commits may print no path under pathspec simplification — fall
    // back to the previous (newer) commit's path, which is still valid there.
    const path =
      lines.slice(1).find((l) => l.trim()) ?? commits[commits.length - 1]?.path ?? relPath;
    commits.push({
      hash,
      shortHash,
      author: author ?? "",
      timestamp: Number(at) * 1000,
      subject: rest.join("\t"),
      path: path.trim(),
    });
  }
  return commits;
}

/**
 * Commit log of a directory; `relPath` "" means the whole repo (project
 * history). Same record format as `listFileHistory`, without rename
 * following (--follow only applies to single files).
 */
export async function listDirHistory(dir: string, relPath: string): Promise<FileCommit[]> {
  const rel = relPath.replace(/\\/g, "/");
  const args = [
    "-c",
    "core.quotepath=false",
    "log",
    "--format=%x01%H%x09%h%x09%an%x09%at%x09%s",
  ];
  if (rel) args.push("--", "./" + rel);
  const out = await gitRun(dir, args);
  if (out.code !== 0) {
    if (/does not have any commits yet|bad default revision|unknown revision/i.test(out.stderr))
      return [];
    throw new GitError(friendlyGitError(out.stderr), out.stderr);
  }
  const commits: FileCommit[] = [];
  for (const record of out.stdout.split("\x01")) {
    if (!record.trim()) continue;
    const [hash, shortHash, author, at, ...rest] = record.split("\n")[0].split("\t");
    if (!hash || !shortHash) continue;
    commits.push({
      hash,
      shortHash,
      author: author ?? "",
      timestamp: Number(at) * 1000,
      subject: rest.join("\t"),
      path: rel,
    });
  }
  return commits;
}

/** Sentinel hash for the pseudo-entry representing uncommitted changes. */
export const WORKING_HASH = "__working__";

export const isWorkingCommit = (c: FileCommit) => c.hash === WORKING_HASH;

/** Pseudo-commit shown at the top of history lists when the working tree is
 *  dirty. `path` must be repo-root-relative (it feeds `git show HEAD:path`). */
export const workingEntry = (path: string, subject: string): FileCommit => ({
  hash: WORKING_HASH,
  shortHash: "工作区",
  author: "",
  timestamp: Date.now(),
  subject,
  path,
});

/** Strip git's C-style quoting ("…") from a porcelain path when present. */
function unquotePath(s: string): string {
  s = s.trim();
  if (s.startsWith('"') && s.endsWith('"')) {
    try {
      return JSON.parse(s) as string;
    } catch {
      return s.slice(1, -1);
    }
  }
  return s;
}

/**
 * Uncommitted changes (staged + unstaged + untracked), optionally limited to
 * a directory or single file (`relPath` relative to `dir`, "" = whole repo).
 * Paths are repo-root-relative, matching `CommitFile` from commits.
 */
export async function listWorkingChanges(dir: string, relPath = ""): Promise<CommitFile[]> {
  const rel = relPath.replace(/\\/g, "/");
  // -uall lists files inside untracked directories individually instead of
  // collapsing them to "dir/".
  const args = ["-c", "core.quotepath=false", "status", "--porcelain", "-uall"];
  if (rel) args.push("--", "./" + rel);
  const out = await gitOk(dir, args);

  const files: CommitFile[] = [];
  for (const line of out.stdout.split("\n")) {
    if (!line.trim()) continue;
    const x = line[0];
    const y = line[1];
    let rest = line.slice(3);
    let oldPath: string | undefined;
    const arrow = rest.indexOf(" -> "); // renames: "R  old -> new"
    if (arrow >= 0) {
      oldPath = unquotePath(rest.slice(0, arrow));
      rest = rest.slice(arrow + 4);
    }
    // Untracked (??) reads as "new file"; otherwise prefer the staged column.
    const status = x === "?" ? "A" : x === " " ? y : x;
    files.push({
      status,
      path: unquotePath(rest),
      ...(oldPath ? { oldPath } : {}),
    });
  }
  return files;
}

async function pathExistsAtHead(dir: string, path: string): Promise<boolean> {
  const out = await gitRun(dir, ["cat-file", "-e", `HEAD:${path}`]);
  return out.code === 0;
}

async function pathKnownToIndex(dir: string, path: string): Promise<boolean> {
  const out = await gitRun(dir, ["ls-files", "--error-unmatch", "--", path]);
  return out.code === 0;
}

/** Discard selected uncommitted changes. Tracked files are restored from HEAD;
 *  staged additions and untracked files are removed via `git clean`. */
export async function discardWorkingChanges(
  dir: string,
  files: CommitFile[],
): Promise<void> {
  const targets = Array.from(
    new Set(
      files
        .flatMap((f) => [f.path, f.oldPath])
        .filter((p): p is string => !!p),
    ),
  );
  if (targets.length === 0) return;

  if (!(await hasCommits(dir))) {
    await gitRun(dir, ["rm", "-r", "--cached", "--ignore-unmatch", "--", ...targets]);
    await gitOk(dir, ["clean", "-fd", "--", ...files.map((f) => f.path)]);
    return;
  }

  const resetTargets: string[] = [];
  const headTargets: string[] = [];
  for (const target of targets) {
    const [inIndex, inHead] = await Promise.all([
      pathKnownToIndex(dir, target),
      pathExistsAtHead(dir, target),
    ]);
    if (inIndex || inHead) resetTargets.push(target);
    if (inHead) headTargets.push(target);
  }

  if (resetTargets.length > 0) {
    await gitOk(dir, ["reset", "-q", "HEAD", "--", ...resetTargets]);
  }
  if (headTargets.length > 0) {
    await gitOk(dir, ["checkout", "-f", "HEAD", "--", ...headTargets]);
  }
  await gitOk(dir, ["clean", "-fd", "--", ...files.map((f) => f.path)]);
}

/** Absolute path of the repo root ( workspace may be a subfolder of it). */
export async function getRepoRoot(dir: string): Promise<string> {
  const out = await gitOk(dir, ["rev-parse", "--show-toplevel"]);
  return out.stdout.trim();
}

/** One file touched by a commit (from --name-status). */
export interface CommitFile {
  /** Status letter: A(dded) / M(odified) / D(eleted) / R(enamed) / C(opied). */
  status: string;
  /** Repo-root-relative path (the post-rename path for renames). */
  path: string;
  /** Pre-rename path, only for renames/copies. */
  oldPath?: string;
}

/**
 * Files changed by a commit, optionally limited to a directory (`relPath`
 * relative to `dir`, "" = no limit). For merge commits `-m` diffs against
 * each parent; duplicates are folded so the list reads as "everything this
 * commit touched".
 */
export async function listCommitFiles(
  dir: string,
  hash: string,
  relPath: string,
): Promise<CommitFile[]> {
  const rel = relPath.replace(/\\/g, "/");
  const args = [
    "-c",
    "core.quotepath=false",
    "diff-tree",
    "-r",
    "--root",
    "-m",
    "--no-commit-id",
    "--name-status",
    hash,
  ];
  if (rel) args.push("--", "./" + rel);
  const out = await gitOk(dir, args);
  const files: CommitFile[] = [];
  const seen = new Set<string>();
  for (const line of out.stdout.split("\n")) {
    if (!line.trim()) continue;
    const [status, a, b] = line.split("\t");
    if (!status || !a) continue;
    const isRename = status.startsWith("R") || status.startsWith("C");
    const path = isRename ? b : a;
    if (!path || seen.has(path)) continue;
    seen.add(path);
    files.push({
      status: status[0],
      path,
      ...(isRename ? { oldPath: a } : {}),
    });
  }
  return files;
}

/** File content at an arbitrary revision, or null when it doesn't exist
 *  there (added/deleted files, or a root commit's nonexistent parent). */
export async function readFileAtRev(
  dir: string,
  rev: string,
  path: string,
): Promise<string | null> {
  const out = await gitRun(dir, ["show", `${rev}:${path}`]);
  return out.code === 0 ? out.stdout : null;
}

/** Full file content at a given commit (text files only). */
export async function readFileAtCommit(dir: string, commit: FileCommit): Promise<string> {
  // commit.path comes from --name-only, i.e. repo-root-relative — exactly
  // what `rev:path` expects (no ./ prefix here).
  const out = await gitOk(dir, ["show", `${commit.hash}:${commit.path}`]);
  return out.stdout;
}

/**
 * Safety commit of all pending workspace changes — used before a version
 * rollback overwrites a file, so the pre-rollback state stays in history.
 */
export const commitPending = (dir: string) => commitAll(dir, syncCommitMessage());

/** Restore the whole working tree to a commit snapshot without moving HEAD.
 *  Callers should ensure the working tree is clean; the restore appears as
 *  ordinary working-tree changes for a later manual or scheduled sync. */
export async function restoreWorkspaceToCommit(dir: string, hash: string): Promise<void> {
  await gitOk(dir, ["restore", "--source", hash, "--worktree", "--", ":/"]);
}

/* ------------------------------ plumbing ------------------------------- */

/** Make sure commits can succeed even without a global git identity. */
async function ensureIdentity(dir: string): Promise<void> {
  const name = await gitRun(dir, ["config", "user.name"]);
  if (name.code !== 0 || !name.stdout.trim())
    await gitOk(dir, ["config", "user.name", "Idea Note"]);
  const email = await gitRun(dir, ["config", "user.email"]);
  if (email.code !== 0 || !email.stdout.trim())
    await gitOk(dir, ["config", "user.email", "idea-note@local"]);
}

async function hasLocalChanges(dir: string): Promise<boolean> {
  const out = await gitOk(dir, ["status", "--porcelain"]);
  return out.stdout.trim().length > 0;
}

/** Stage everything and commit if there is anything to commit; returns
 *  whether a commit was actually created. */
async function commitAll(dir: string, message: string): Promise<boolean> {
  await gitOk(dir, ["add", "-A"]);
  if (!(await hasLocalChanges(dir))) return false;
  await ensureIdentity(dir);
  await gitOk(dir, ["commit", "-m", message]);
  return true;
}

/** Commits on origin/<branch> that HEAD lacks (0 = nothing to merge).
 *  Unknown (e.g. missing ref) counts as 1 so callers stay on the safe path. */
async function behindCount(dir: string, branch: string): Promise<number> {
  const out = await gitRun(dir, ["rev-list", "--count", `HEAD..origin/${branch}`]);
  return out.code === 0 ? Number(out.stdout.trim()) || 0 : 1;
}

/** Commits in HEAD that origin/<branch> lacks (0 = nothing to push). */
async function aheadCount(dir: string, branch: string): Promise<number> {
  const out = await gitRun(dir, ["rev-list", "--count", `origin/${branch}..HEAD`]);
  return out.code === 0 ? Number(out.stdout.trim()) || 0 : 1;
}

/** Whether the repo has at least one local commit (HEAD resolves). */
async function hasCommits(dir: string): Promise<boolean> {
  const out = await gitRun(dir, ["rev-parse", "--verify", "-q", "HEAD"]);
  return out.code === 0;
}

/** Remote's default branch (e.g. "main"), if origin/HEAD or any remote branch exists. */
async function getRemoteDefaultBranch(dir: string): Promise<string | null> {
  const head = await gitRun(dir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (head.code === 0) return head.stdout.trim().replace(/^origin\//, "");
  const branches = await gitRun(dir, ["branch", "-r", "--format=%(refname:short)"]);
  if (branches.code !== 0) return null;
  const names = branches.stdout
    .split("\n")
    .map((b) => b.trim().replace(/^origin\//, ""))
    .filter((b) => b && !b.includes("HEAD"));
  return names.find((b) => b === "main" || b === "master") ?? names[0] ?? null;
}

async function remoteBranchExists(dir: string, branch: string): Promise<boolean> {
  const out = await gitRun(dir, ["rev-parse", "--verify", "-q", `refs/remotes/origin/${branch}`]);
  return out.code === 0;
}

/** Files left in a conflicted state by the last merge (porcelain XY codes). */
async function listConflictFiles(dir: string): Promise<string[]> {
  const out = await gitOk(dir, ["status", "--porcelain"]);
  return out.stdout
    .split("\n")
    .filter((line) => /^(UU|AA|DD|AU|UA|DU|UD) /.test(line))
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

/** If a merge is half-done (MERGE_HEAD exists), abort it to restore a clean state. */
async function abortMergeIfAny(dir: string): Promise<void> {
  const merging = await gitRun(dir, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
  if (merging.code === 0) await gitRun(dir, ["merge", "--abort"]);
}

const syncCommitMessage = () => `sync: ${new Date().toLocaleString("zh-CN", { hour12: false })}`;

/**
 * Merge `origin/<branch>` into the local branch. On conflict, keep both
 * sides' markers in the files and complete the merge commit — never blocks.
 * Returns the conflicted file list (empty when the merge was clean).
 */
async function mergeRemote(
  dir: string,
  branch: string,
  extraArgs: string[] = [],
): Promise<string[]> {
  const merge = await gitRun(dir, ["merge", `origin/${branch}`, "--no-edit", ...extraArgs]);
  if (merge.code === 0) return [];
  const conflicts = await listConflictFiles(dir);
  if (conflicts.length === 0) {
    // Failed for a non-conflict reason — restore a clean state and surface it.
    await abortMergeIfAny(dir);
    throw new GitError(friendlyGitError(merge.stderr), merge.stderr);
  }
  await gitOk(dir, ["add", "-A"]);
  const commit = await gitRun(dir, ["commit", "--no-edit"]);
  if (commit.code !== 0) {
    await abortMergeIfAny(dir);
    throw new GitError(friendlyGitError(commit.stderr), commit.stderr);
  }
  return conflicts;
}

/* ----------------------------- attach/clone ---------------------------- */

/**
 * Init a local-only repo (no remote): git init + first commit, so sync and
 * file history work without ever touching the network.
 */
export async function initLocalRepo(dir: string): Promise<void> {
  if (!(await isGitRepo(dir))) await gitOk(dir, ["init"]);
  await commitAll(dir, syncCommitMessage());
  if (!(await hasCommits(dir))) {
    await ensureIdentity(dir);
    await gitOk(dir, ["commit", "--allow-empty", "-m", "init: idea note"]);
  }
}

/**
 * Turn an existing workspace folder into a git repo synced with `url`
 * (or attach `url` to a repo that has no origin yet). On a failed fetch the
 * remote is removed again so the folder is left as it was.
 */
export async function attachRemote(dir: string, url: string, proxy?: string): Promise<void> {
  if (!(await isGitRepo(dir))) await gitOk(dir, ["init"]);
  const hadOrigin = (await getRemoteUrl(dir)) !== null;
  await gitOk(dir, hadOrigin ? ["remote", "set-url", "origin", url] : ["remote", "add", "origin", url]);

  try {
    await gitOk(dir, withProxy(proxy, ["fetch", "origin"]));
  } catch (err) {
    // Bad URL / no access — undo so the user can retry cleanly.
    if (!hadOrigin) await gitRun(dir, ["remote", "remove", "origin"]);
    throw err;
  }

  await commitAll(dir, syncCommitMessage());

  const remoteBranch = await getRemoteDefaultBranch(dir);
  let branch = await getCurrentBranch(dir);

  if (remoteBranch) {
    if (!(await hasCommits(dir))) {
      // Empty local repo: just check out the remote branch's content.
      await gitOk(dir, ["checkout", "-B", remoteBranch, `origin/${remoteBranch}`]);
      return;
    }
    // Local history exists: align branch names, then merge unrelated histories
    // (conflicts keep both sides, same policy as a normal sync).
    if (branch && branch !== remoteBranch) {
      await gitOk(dir, ["branch", "-M", remoteBranch]);
      branch = remoteBranch;
    }
    await mergeRemote(dir, remoteBranch, ["--allow-unrelated-histories"]);
    await gitOk(dir, withProxy(proxy, ["push", "-u", "origin", remoteBranch]));
    return;
  }

  // Empty remote: push our first commit (create one if the folder was empty).
  if (!(await hasCommits(dir))) {
    await ensureIdentity(dir);
    await gitOk(dir, ["commit", "--allow-empty", "-m", "init: idea note"]);
  }
  branch = (await getCurrentBranch(dir)) ?? "main";
  await gitOk(dir, withProxy(proxy, ["push", "-u", "origin", branch]));
}

/** Clone `url` into a new folder under `parentDir`; returns the new path. */
export async function cloneRemote(url: string, parentDir: string, proxy?: string): Promise<string> {
  const name = repoNameFromUrl(url);
  await gitOk(parentDir, withProxy(proxy, ["clone", url, name]));
  const sep = parentDir.includes("\\") ? "\\" : "/";
  return `${parentDir.replace(/[\\/]$/, "")}${sep}${name}`;
}

/** Derive the local folder name git clone would use from a remote URL. */
export function repoNameFromUrl(url: string): string {
  const last = url.replace(/\/+$/, "").split(/[/:]/).pop() ?? "repo";
  return last.replace(/\.git$/i, "") || "repo";
}

/* -------------------------------- sync --------------------------------- */

export interface SyncResult {
  ok: boolean;
  /** Files committed with conflict markers left inside (user should tidy them). */
  conflictFiles: string[];
  /** Whether anything actually moved: a local commit was created, remote
   *  commits were merged in, or something was pushed. False = already
   *  up to date (callers keep the previous "last synced" timestamp). */
  changed: boolean;
  message: string;
}

/**
 * Full sync: commit local edits → fetch → merge (conflicts keep both sides)
 * → push. Every failure path leaves the repo in a stable, non-merging state;
 * local changes are always committed first so nothing is ever lost.
 * Without a remote this is just the commit step (local snapshot).
 */
export async function syncWorkspace(dir: string, proxy?: string): Promise<SyncResult> {
  try {
    if (!(await isGitRepo(dir))) {
      return {
        ok: false,
        conflictFiles: [],
        changed: false,
        message: "尚未开启同步，请在设置中关联远程或开启本地同步",
      };
    }

    // No remote configured → local-only sync: just commit, skip fetch/merge/push.
    if (!(await getRemoteUrl(dir))) {
      const committed = await commitAll(dir, syncCommitMessage());
      return committed
        ? { ok: true, conflictFiles: [], changed: true, message: "已同步到本地仓库" }
        : { ok: true, conflictFiles: [], changed: false, message: "已是最新，无需同步" };
    }

    // 1. Local edits become a commit before anything touches the network.
    const committed = await commitAll(dir, syncCommitMessage());

    // 2. Fetch; offline is fine — the local commit already protects the data.
    const fetch = await gitRun(dir, withProxy(proxy, ["fetch", "origin"]));
    if (fetch.code !== 0) {
      return {
        ok: false,
        conflictFiles: [],
        changed: false,
        message: `${friendlyGitError(fetch.stderr)}（本地更改已保存，恢复后重试）`,
      };
    }

    const branch = (await getCurrentBranch(dir)) ?? "main";
    const branchOnRemote = await remoteBranchExists(dir, branch);
    let conflicts: string[] = [];
    let pulled = false;

    // 3. Merge the remote branch — but only when it actually has new commits
    //    (a no-op merge still costs a spawn and muddies the "changed" signal).
    if (branchOnRemote) {
      if (await hasCommits(dir)) {
        if ((await behindCount(dir, branch)) > 0) {
          conflicts = await mergeRemote(dir, branch);
          pulled = true;
        }
      } else {
        await gitOk(dir, ["checkout", "-B", branch, `origin/${branch}`]);
        pulled = true;
      }
    }

    if (!(await hasCommits(dir))) {
      return { ok: true, conflictFiles: [], changed: false, message: "没有可同步的内容" };
    }

    // 4. Push — skipped entirely when the remote already has everything,
    //    which saves a full network round-trip on no-change syncs. One retry
    //    if someone else pushed between our fetch and push.
    let pushed = false;
    if (!branchOnRemote || (await aheadCount(dir, branch)) > 0) {
      let push = await gitRun(dir, withProxy(proxy, ["push", "-u", "origin", branch]));
      if (push.code !== 0 && /fetch first|non-fast-forward|rejected/i.test(push.stderr)) {
        const refetch = await gitRun(dir, withProxy(proxy, ["fetch", "origin"]));
        if (refetch.code === 0) {
          conflicts = [...conflicts, ...(await mergeRemote(dir, branch))];
          pulled = true;
          push = await gitRun(dir, withProxy(proxy, ["push", "-u", "origin", branch]));
        }
      }
      if (push.code !== 0) {
        return {
          ok: false,
          conflictFiles: conflicts,
          changed: committed || pulled,
          message: `${friendlyGitError(push.stderr)}（本地更改已保存）`,
        };
      }
      pushed = true;
    }

    const changed = committed || pulled || pushed;
    if (conflicts.length > 0) {
      return {
        ok: true,
        conflictFiles: conflicts,
        changed: true,
        message: `已同步，${conflicts.length} 个文件存在冲突待处理`,
      };
    }
    return changed
      ? { ok: true, conflictFiles: [], changed: true, message: "同步成功" }
      : { ok: true, conflictFiles: [], changed: false, message: "已是最新，无需同步" };
  } catch (err) {
    // Whatever went wrong, never leave a half-finished merge behind.
    await abortMergeIfAny(dir).catch(() => {});
    const message = err instanceof GitError ? err.message : `同步失败：${String(err)}`;
    return { ok: false, conflictFiles: [], changed: false, message };
  }
}
