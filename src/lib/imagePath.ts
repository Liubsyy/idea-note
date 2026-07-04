// Resolve a markdown image src to a URL the WKWebView can actually load.
// Local paths go through Tauri's asset protocol (convertFileSrc); the `..`
// segments must be collapsed first because the asset protocol rejects them.

import { convertFileSrc } from "@tauri-apps/api/core";
import { useAppStore } from "../store/useAppStore";
import { dirname } from "./fs";

const REMOTE = /^(https?:|data:|blob:|asset:|tauri:)/i;
const GITHUB_BLOB =
  /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/i;

/** Collapse "." / ".." segments (expects "/" separators). A Windows drive
 *  root ("D:/…") is preserved so the result stays a valid absolute path. */
function normalizePath(p: string): string {
  const drive = /^[a-zA-Z]:\//.test(p) ? p.slice(0, 2) : "";
  const stack: string[] = [];
  for (const seg of (drive ? p.slice(2) : p).split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") stack.pop();
    else stack.push(seg);
  }
  return drive + "/" + stack.join("/");
}

export function toDisplaySrc(src: string): string {
  if (!src) return src;
  // A <…>-wrapped destination is CommonMark's way to allow spaces; unwrap it.
  let s = src.trim();
  if (s.startsWith("<") && s.endsWith(">")) s = s.slice(1, -1);

  const githubBlob = s.match(GITHUB_BLOB);
  if (githubBlob) {
    const [, owner, repo, ref, path] = githubBlob;
    return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`;
  }
  if (REMOTE.test(s) || s.includes("asset.localhost")) return s;

  // Local path: decode percent-escapes (e.g. %20) so the real filename reaches
  // convertFileSrc, which re-encodes it for the asset URL. A lone "%" or other
  // malformed escape throws — keep the path as-is then.
  try {
    s = decodeURI(s);
  } catch {
    /* malformed escape — use the path verbatim */
  }

  // Windows paths arrive with backslashes (backend PathBuf, pasted links);
  // switch to "/" so one normalization path serves both platforms.
  s = s.replace(/\\/g, "/");

  // Absolute: POSIX "/…", Windows drive "D:/…", or UNC "//server/…".
  const isAbs = s.startsWith("/") || /^[a-zA-Z]:\//.test(s);
  let abs = s;
  if (!isAbs) {
    const active = useAppStore.getState().activeFilePath;
    if (!active) return src;
    abs = `${dirname(active).replace(/\\/g, "/")}/${s}`;
  }
  abs = normalizePath(abs);
  try {
    return convertFileSrc(abs);
  } catch {
    return src;
  }
}
