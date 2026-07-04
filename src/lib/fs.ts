// Thin typed wrappers around the Rust file commands defined in
// src-tauri/src/lib.rs, plus the native folder picker dialog.

import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";

export interface FileNode {
  name: string;
  path: string;
  is_dir: boolean;
  children?: FileNode[] | null;
  /** Last-modified time in epoch milliseconds (files only). */
  mtime?: number | null;
  /** First content line of a markdown note (sidebar notes-mode preview). */
  excerpt?: string | null;
}

export const listDir = (path: string) =>
  invoke<FileNode[]>("list_dir", { path });

/** One `search_notes` match: filename hits have `line: null`, content hits
 *  carry the 1-based line number and a trimmed snippet. */
export interface SearchHit {
  path: string;
  name: string;
  line: number | null;
  snippet: string | null;
}

export const searchNotes = (dir: string, query: string) =>
  invoke<SearchHit[]>("search_notes", { dir, query });

export const readFile = (path: string) =>
  invoke<string>("read_file", { path });

/** Cheap stat (mtime in epoch ms + byte size) for detecting external changes
 *  without reading the file. Returns null when it's gone or unreadable. */
export async function fileStat(
  path: string,
): Promise<{ mtime: number; size: number } | null> {
  try {
    const [mtime, size] = await invoke<[number, number]>("file_stat", { path });
    return { mtime, size };
  } catch {
    return null;
  }
}

/** Whether `path` is a directory (for bare OS paths, e.g. drag-and-drop). */
export const pathIsDir = (path: string) => invoke<boolean>("is_dir", { path });

/** Drain files the app was launched to open via the OS "Open With" menu. */
export const takePendingOpenFiles = () =>
  invoke<string[]>("take_pending_open_files");

export const writeFile = (path: string, content: string) =>
  invoke<void>("write_file", { path, content });

/** Write raw bytes into `dir/name` (created if needed; clashes get a " 2"
 *  suffix). Returns the path actually written. Backs pasting an image blob. */
export const writeBinaryFile = (dir: string, name: string, data: number[]) =>
  invoke<string>("write_binary_file", { dir, name, data });

/** Copy an existing file into `dir` under `name`. Returns the created path.
 *  Backs pasting a real file that was copied in Finder/Explorer into a note. */
export const saveFileToDir = (src: string, dir: string, name: string) =>
  invoke<string>("save_file_to_dir", { src, dir, name });

export const createFile = (dir: string, name: string) =>
  invoke<string>("create_file", { dir, name });

/** Create a file with the exact given name (extension required, no `.md` defaulting). */
export const createRawFile = (dir: string, name: string) =>
  invoke<string>("create_raw_file", { dir, name });

export const createFolder = (dir: string, name: string) =>
  invoke<string>("create_folder", { dir, name });

export const renamePath = (path: string, newName: string) =>
  invoke<string>("rename", { path, newName });

/** Move `path` into `destDir`, keeping its name. Returns the new path. */
export const movePath = (path: string, destDir: string) =>
  invoke<string>("move_path", { path, destDir });

export const deletePath = (path: string) => invoke<void>("delete", { path });

/** Open the OS file-info window (Finder "Get Info"). */
export const showFileInfo = (path: string) =>
  invoke<void>("show_file_info", { path });

/** Depth-first lookup of a node by its path within a file tree. */
export function findNode(nodes: FileNode[], path: string): FileNode | null {
  for (const node of nodes) {
    if (node.path === path) return node;
    if (node.children) {
      const found = findNode(node.children, path);
      if (found) return found;
    }
  }
  return null;
}

/** Open the native directory picker; returns the chosen path or null. */
export async function pickWorkspace(): Promise<string | null> {
  const selected = await open({
    directory: true,
    multiple: false,
    title: "选择笔记文件夹",
  });
  return typeof selected === "string" ? selected : null;
}

/** Open the native "save as" dialog; returns the chosen absolute path or null
 *  (cancelled). Used to save an untitled draft to a real file. */
export async function pickSavePath(defaultPath?: string): Promise<string | null> {
  const selected = await save({
    title: "保存为",
    defaultPath,
    filters: [
      { name: "Markdown", extensions: ["md", "markdown"] },
      { name: "所有文件", extensions: ["*"] },
    ],
  });
  return selected ?? null;
}

/** Open the native image picker; returns the chosen absolute path or null. */
export async function pickImage(): Promise<string | null> {
  const selected = await open({
    multiple: false,
    title: "选择图片",
    filters: [
      {
        name: "图片",
        extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif"],
      },
    ],
  });
  return typeof selected === "string" ? selected : null;
}

/** True for markdown files (the only type that gets live-preview + toolbar). */
export const isMarkdownFile = (path: string) => /\.(md|markdown)$/i.test(path);

/** True for image files we can display directly in an <img>. */
export const isImageFile = (path: string) =>
  /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico)$/i.test(path);

/** Basename helper that works for both `/` and `\` separators. */
export function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** Parent directory of a path. */
export function dirname(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx >= 0 ? path.slice(0, idx) : path;
}
