// Clipboard helpers for the file tree context menu.

import { invoke } from "@tauri-apps/api/core";
import { fetch as nativeFetch } from "@tauri-apps/plugin-http";
import { toDisplaySrc } from "./imagePath";

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

/** Put files themselves on the system clipboard (pasteable in Finder/Explorer). */
export const copyFilesToClipboard = (paths: string[]) =>
  invoke<void>("copy_files_to_clipboard", { paths });

/** Single-file convenience wrapper used outside the multi-select file tree. */
export const copyFileToClipboard = (path: string) => copyFilesToClipboard([path]);

/** Copy full-resolution pixels, independent of the size used in the note.
 * Native HTTP avoids cross-origin canvas restrictions for remote images. */
export async function copyImageToClipboard(source: string): Promise<void> {
  const src = toDisplaySrc(source);
  const response = await (/^https?:/i.test(src) && !src.includes("asset.localhost")
    ? nativeFetch(src)
    : fetch(src));
  if (!response.ok) throw new Error(`图片读取失败（${response.status}）`);
  const objectUrl = URL.createObjectURL(await response.blob());
  try {
    const image = new Image();
    image.src = objectUrl;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context || !canvas.width || !canvas.height) throw new Error("无法读取图片内容");
    context.drawImage(image, 0, 0);
    const png = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("图片转换失败")), "image/png"),
    );
    await invoke<void>("copy_image_to_clipboard", { png: Array.from(new Uint8Array(await png.arrayBuffer())) });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/** Copy the clipboard's files into `targetDir`; resolves to the created paths. */
export const pasteFromClipboard = (targetDir: string) =>
  invoke<string[]>("paste_from_clipboard", { targetDir });

/** Absolute paths of the real files currently on the system clipboard (set by
 *  Finder/Explorer). Used by the editor's paste to route them into the
 *  configured image/attachment directory. */
export const listClipboardFiles = () =>
  invoke<string[]>("list_clipboard_files");

export const hasClipboardImage = () => invoke<boolean>("has_clipboard_image");

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
