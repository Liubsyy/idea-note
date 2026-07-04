// Paste images / files into a markdown note: the real file is written to the
// directory configured in Settings › 图片/附件, and a markdown reference (image
// embed or attachment link) is inserted at the cursor. Two sources are handled:
//   1. blobs on the web clipboard (screenshots, copied images, dragged files)
//   2. real files copied in Finder/Explorer (resolved via the native clipboard)

import type { EditorView } from "@codemirror/view";
import { EditorSelection } from "@codemirror/state";

import { useAppStore, isDraftPath, type AttachmentLocation } from "../store/useAppStore";
import {
  basename,
  dirname,
  isImageFile,
  writeBinaryFile,
  saveFileToDir,
} from "./fs";
import { listClipboardFiles, saveClipboardImageToDir } from "./clipboard";

type Kind = "image" | "attachment";

interface Target {
  /** Absolute directory the file is written into. */
  dir: string;
  /** Build the markdown link/src for the final (possibly suffixed) filename. */
  makeLink: (filename: string) => string;
}

/** Collapse repeated/edge slashes; drop empty segments. Keeps a leading "/". */
function joinPath(...parts: string[]): string {
  const lead = parts[0]?.startsWith("/") ? "/" : "";
  const segs = parts
    .join("/")
    .split(/[\\/]+/)
    .filter(Boolean);
  return lead + segs.join("/");
}

/** Path of `toPath` relative to directory `fromDir` (both absolute), using "/". */
function relativeFrom(fromDir: string, toPath: string): string {
  const from = fromDir.split(/[\\/]+/).filter(Boolean);
  const to = toPath.split(/[\\/]+/).filter(Boolean);
  let i = 0;
  while (i < from.length && i < to.length && from[i] === to[i]) i++;
  const up = from.slice(i).map(() => "..");
  const down = to.slice(i);
  const rel = [...up, ...down].join("/");
  return rel || ".";
}

/** Trim surrounding slashes from a user-entered sub-folder. */
const trimSub = (s: string) => s.trim().replace(/^[\\/]+|[\\/]+$/g, "");

/**
 * Resolve where a file of `kind` should be written and how its link is formed,
 * from the current settings + active note. Returns null (with a toast) when it
 * can't be resolved — e.g. a relative/project location while the note is an
 * unsaved draft, or an absolute location with no path configured.
 */
function resolveTarget(kind: Kind): Target | null {
  const s = useAppStore.getState();
  const location: AttachmentLocation =
    kind === "image" ? s.imageLocation : s.attachmentLocation;
  const rawDir = kind === "image" ? s.imageDir : s.attachmentDir;

  const mdPath = s.activeFilePath;
  const mdDir = mdPath && !isDraftPath(mdPath) ? dirname(mdPath) : null;

  if (location === "absolute") {
    const base = rawDir.trim().replace(/[\\/]+$/g, "");
    if (!base) {
      s.showToast("请先在设置中填写绝对目录", "error");
      return null;
    }
    return { dir: base, makeLink: (f) => joinPath(base, f) };
  }

  const sub = trimSub(rawDir);

  if (location === "project") {
    const ws = s.workspacePath;
    if (!ws) {
      s.showToast("当前没有打开的工程，无法粘贴到工程目录", "error");
      return null;
    }
    const dir = joinPath(ws, sub);
    if (!mdDir) {
      s.showToast("请先保存笔记后再粘贴", "error");
      return null;
    }
    return { dir, makeLink: (f) => relativeFrom(mdDir, joinPath(dir, f)) };
  }

  // "relative": a sub-folder beside the note itself.
  if (!mdDir) {
    s.showToast("请先保存笔记后再粘贴", "error");
    return null;
  }
  return { dir: joinPath(mdDir, sub), makeLink: (f) => joinPath(sub, f) };
}

/** Replace whitespace / markdown- and URL-hostile chars so the link stays valid
 *  without needing escaping (the extension is preserved). */
function sanitizeName(name: string): string {
  return name.replace(/[\s()[\]<>#?*|"]+/g, "_").replace(/_+/g, "_");
}

const pad = (n: number) => String(n).padStart(2, "0");

/** A timestamp stem like 20260625-143012 for blobs that arrive without a name. */
function timestamp(): string {
  const d = new Date();
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

/** A filename for a pasted blob: its own name when meaningful, else generated. */
function deriveBlobName(file: File, isImage: boolean): string {
  if (file.name && file.name.trim()) return file.name;
  const subtype = file.type.split("/")[1] || (isImage ? "png" : "bin");
  const ext = subtype === "jpeg" ? "jpg" : subtype;
  return `${isImage ? "image" : "file"}-${timestamp()}.${ext}`;
}

interface Ref {
  link: string;
  name: string;
  isImage: boolean;
}

/** Insert image embeds / attachment links at the cursor, one per line. */
function insertRefs(view: EditorView, refs: Ref[]): void {
  if (refs.length === 0) return;
  const text = refs
    .map((r) => (r.isImage ? `![](${r.link})` : `[${r.name}](${r.link})`))
    .join("\n");
  const range = view.state.selection.main;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: text },
    selection: EditorSelection.cursor(range.from + text.length),
  });
  view.focus();
}

const toastError = (e: unknown) =>
  useAppStore.getState().showToast(e instanceof Error ? e.message : String(e), "error");

/** Fallback for path-less clipboard data (screenshots, images copied from a web
 *  page): there is no file on disk, so the blob's bytes are shipped to Rust.
 *  Real on-disk files go through saveByPaths instead (no bytes through the
 *  webview) — see savePastedFiles. */
async function saveBlobs(view: EditorView, files: File[]): Promise<void> {
  const refs: Ref[] = [];
  for (const file of files) {
    const isImage = file.type.startsWith("image/") || isImageFile(file.name);
    const target = resolveTarget(isImage ? "image" : "attachment");
    if (!target) return;
    const name = sanitizeName(deriveBlobName(file, isImage));
    try {
      const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
      const created = await writeBinaryFile(target.dir, name, bytes);
      const finalName = basename(created);
      refs.push({ link: target.makeLink(finalName), name: finalName, isImage });
    } catch (e) {
      toastError(e);
      return;
    }
  }
  insertRefs(view, refs);
}

/** Copy real on-disk files into the configured dir *by path* — Rust does the
 *  copy (fs::copy), so the bytes never pass through the webview. This is the
 *  path even a multi-hundred-MB file takes. */
async function saveByPaths(view: EditorView, paths: string[]): Promise<void> {
  const refs: Ref[] = [];
  for (const src of paths) {
    const isImage = isImageFile(src);
    const target = resolveTarget(isImage ? "image" : "attachment");
    if (!target) return;
    const name = sanitizeName(basename(src));
    try {
      const created = await saveFileToDir(src, target.dir, name);
      const finalName = basename(created);
      refs.push({ link: target.makeLink(finalName), name: finalName, isImage });
    } catch (e) {
      toastError(e);
      return;
    }
  }
  insertRefs(view, refs);
}

/** A filename stem (no extension) for a pasted clipboard image: the source
 *  blob's own name when meaningful, else a timestamp. Rust writes it as .png. */
function clipboardImageStem(blobs: File[]): string {
  const raw = blobs.find((b) => b.type.startsWith("image/"))?.name?.trim();
  if (raw) {
    const dot = raw.lastIndexOf(".");
    return sanitizeName(dot > 0 ? raw.slice(0, dot) : raw);
  }
  return `image-${timestamp()}`;
}

/**
 * Resolve a file paste, preferring native handling so bytes never pass through
 * the webview:
 *   1. A file copied in Finder/Explorer exists on disk → Rust copies it by path.
 *   2. A path-less clipboard image (screenshot, image copied from a web page) →
 *      Rust reads the pasteboard image bytes and writes the file directly.
 *   3. Anything else (a non-image path-less blob) → ship the blob bytes as a
 *      last resort.
 * This is what keeps a large paste from freezing the app.
 */
async function savePastedFiles(view: EditorView, blobs: File[]): Promise<void> {
  try {
    const paths = await listClipboardFiles();
    if (paths.length > 0) {
      await saveByPaths(view, paths);
      return;
    }
  } catch {
    /* no native file paths available — fall through */
  }

  if (blobs.some((b) => b.type.startsWith("image/"))) {
    const target = resolveTarget("image");
    if (!target) return;
    try {
      const created = await saveClipboardImageToDir(target.dir, clipboardImageStem(blobs));
      if (created) {
        const finalName = basename(created);
        insertRefs(view, [
          { link: target.makeLink(finalName), name: finalName, isImage: true },
        ]);
        return;
      }
    } catch {
      /* clipboard read failed — fall back to the blob bytes below */
    }
  }

  if (blobs.length > 0) await saveBlobs(view, blobs);
}

/**
 * Editor paste handler (markdown notes only). Returns true when the paste was
 * consumed as a file paste; false lets CodeMirror handle it as a normal text
 * paste. The actual file writes + link insertion run asynchronously.
 */
export function handleEditorPaste(view: EditorView, event: ClipboardEvent): boolean {
  const dt = event.clipboardData;

  const blobs: File[] = [];
  if (dt) {
    for (const item of Array.from(dt.items)) {
      if (item.kind === "file") {
        const f = item.getAsFile();
        if (f) blobs.push(f);
      }
    }
  }

  // Plain text and no file on the clipboard → let CodeMirror paste it normally.
  const types = dt ? Array.from(dt.types) : [];
  if (blobs.length === 0 && types.some((t) => t.startsWith("text/"))) return false;

  // A file is involved — either as a web blob, a real file on the native
  // clipboard, or both. Prefer copying the on-disk file by path over reading
  // the blob's bytes; see savePastedFiles.
  event.preventDefault();
  void savePastedFiles(view, blobs);
  return true;
}
