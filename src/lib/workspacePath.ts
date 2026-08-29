export type WorkspacePathResult =
  | { ok: true; path: string }
  | { ok: false; error: string };

const OUTSIDE_WORKSPACE = "路径不在当前工作区内。";

/** True for POSIX, Windows drive-letter, and UNC absolute paths. */
function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[a-zA-Z]:\//.test(path);
}

/**
 * Normalize either Windows or POSIX paths to forward slashes for comparison.
 * UNC's leading double slash and Windows drive roots are preserved.
 */
function normalizePath(path: string): string {
  const value = path.replace(/\\/g, "/");
  const drive = value.match(/^([a-zA-Z]:)(?:\/|$)/)?.[1] ?? "";
  const isUnc = !drive && value.startsWith("//");
  const isPosix = !drive && !isUnc && value.startsWith("/");
  const rest = drive
    ? value.slice(drive.length).replace(/^\/+/, "")
    : value.replace(/^\/+/, "");
  const parts: string[] = [];

  for (const segment of rest.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }

  if (drive) return `${drive}/${parts.join("/")}`;
  if (isUnc) return `//${parts.join("/")}`;
  if (isPosix) return `/${parts.join("/")}`;
  return parts.join("/");
}

function usesCaseInsensitivePaths(path: string): boolean {
  return /^[a-zA-Z]:\//.test(path) || path.startsWith("//");
}

function toNativeSeparators(path: string, separator: "/" | "\\"): string {
  return separator === "\\" ? path.replace(/\//g, "\\") : path;
}

/**
 * Resolve a user/model-provided path inside a workspace without touching the
 * filesystem. Both slash styles are accepted on every platform; the returned
 * path follows the workspace's separator style so it matches backend paths.
 */
export function resolvePathWithinWorkspace(
  workspacePath: string,
  inputPath: string,
): WorkspacePathResult {
  const workspace = normalizePath(workspacePath.trim());
  const raw = inputPath.trim().replace(/\\/g, "/");
  if (!workspace || !raw) {
    return { ok: false, error: raw ? OUTSIDE_WORKSPACE : "路径不能为空。" };
  }

  const candidate = normalizePath(isAbsolutePath(raw) ? raw : `${workspace}/${raw}`);
  const caseInsensitive = usesCaseInsensitivePaths(workspace);
  const comparableWorkspace = caseInsensitive ? workspace.toLowerCase() : workspace;
  const comparableCandidate = caseInsensitive ? candidate.toLowerCase() : candidate;
  const workspaceBoundary = comparableWorkspace.endsWith("/")
    ? comparableWorkspace
    : `${comparableWorkspace}/`;
  const isInside =
    comparableCandidate === comparableWorkspace ||
    comparableCandidate.startsWith(workspaceBoundary);

  if (!isInside) return { ok: false, error: OUTSIDE_WORKSPACE };

  const relative = candidate.slice(workspace.length).replace(/^\//, "");
  const separator: "/" | "\\" = workspacePath.includes("\\") ? "\\" : "/";
  const nativeWorkspace = toNativeSeparators(workspace, separator);
  const nativeRelative = toNativeSeparators(relative, separator);
  const workspacePrefix = nativeWorkspace.endsWith(separator)
    ? nativeWorkspace
    : `${nativeWorkspace}${separator}`;
  return {
    ok: true,
    path: nativeRelative ? `${workspacePrefix}${nativeRelative}` : nativeWorkspace,
  };
}
