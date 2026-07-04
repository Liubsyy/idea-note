// Clipboard helpers for the file tree context menu.

import { invoke } from "@tauri-apps/api/core";

/** Copy plain text, falling back to execCommand when the async API is blocked. */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

/** Read plain text, falling back to the Rust command when the async API is
 *  unavailable (WKWebView has no reliable clipboard read). */
export async function readClipboardText(): Promise<string> {
  try {
    const text = await navigator.clipboard.readText();
    if (text) return text;
  } catch {
    // fall through to the native path
  }
  try {
    return await invoke<string>("read_clipboard_text");
  } catch {
    return "";
  }
}

/** Put the file itself on the system clipboard (pasteable in Finder/Explorer). */
export const copyFileToClipboard = (path: string) =>
  invoke<void>("copy_file_to_clipboard", { path });

/** Copy the clipboard's files into `targetDir`; resolves to the created paths. */
export const pasteFromClipboard = (targetDir: string) =>
  invoke<string[]>("paste_from_clipboard", { targetDir });

/** Absolute paths of the real files currently on the system clipboard (set by
 *  Finder/Explorer). Used by the editor's paste to route them into the
 *  configured image/attachment directory. */
export const listClipboardFiles = () =>
  invoke<string[]>("list_clipboard_files");

/** Save the image on the system clipboard (a screenshot or web-copied image)
 *  into `dir` as `<stem>.png`, returning the created path — or null when the
 *  clipboard holds no image. The bytes are read natively, never via the webview,
 *  so even a large image doesn't freeze the editor. */
export const saveClipboardImageToDir = (dir: string, stem: string) =>
  invoke<string | null>("save_clipboard_image_to_dir", { dir, stem });

/** Path of `path` relative to `base`; returns `path` unchanged if outside `base`. */
export function relativePath(path: string, base: string | null): string {
  if (!base) return path;
  if (path === base) return ".";
  for (const sep of ["/", "\\"]) {
    const prefix = base.endsWith(sep) ? base : base + sep;
    if (path.startsWith(prefix)) return path.slice(prefix.length);
  }
  return path;
}
