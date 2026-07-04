// The tools the model can call, plus the editor-side helpers that read/diff/
// apply changes. The actual orchestration (approval flow, UI updates) lives in
// useChatStore.sendMessage — this module stays focused on "what does the tool
// do to the open document".

import { diffLines } from "diff";
import type { ToolDef } from "./types";
import { getActiveView } from "../codemirror/activeView";
import { useAppStore } from "../../store/useAppStore";
import {
  basename,
  isImageFile,
  createFile,
  readFile,
  writeFile,
  findNode,
  searchNotes,
  type SearchHit,
} from "../fs";

/* ------------------------------- tool defs ------------------------------- */

export const TOOL_DEFS: ToolDef[] = [
  {
    name: "read_open_file",
    description: "读取用户当前在编辑器中打开的文件的完整内容。无参数。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "read_file",
    description:
      "按路径读取当前工作区中的某个文本文件。用户明确提到文件名或路径时使用它；如果路径不确定，先用 search_notes 查找。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "要读取的文件路径（相对工作区根目录或绝对路径）。" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "edit_open_file",
    description:
      "对当前打开的文件做精确字符串替换。old_string 必须与文件中的文本完全一致（含缩进与换行）。优先用它做局部修改。",
    parameters: {
      type: "object",
      properties: {
        old_string: { type: "string", description: "要被替换的原文本，需在文件中完全匹配。" },
        new_string: { type: "string", description: "替换后的新文本。" },
        replace_all: { type: "boolean", description: "是否替换所有匹配项，默认 false（仅第一处）。" },
      },
      required: ["old_string", "new_string"],
      additionalProperties: false,
    },
  },
  {
    name: "write_open_file",
    description: "用全新内容整体替换当前打开文件的全部内容。仅在需要大段重写时使用。",
    parameters: {
      type: "object",
      properties: { content: { type: "string", description: "文件的完整新内容。" } },
      required: ["content"],
      additionalProperties: false,
    },
  },
  {
    name: "create_note",
    description:
      "在工作区中新建一篇 Markdown 笔记并在编辑器中打开。可选地写入初始内容。同名文件已存在时会报错。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "笔记文件名，可不带 .md 后缀，不能包含路径分隔符。" },
        dir: { type: "string", description: "目标文件夹（相对工作区根目录），省略则创建在根目录。" },
        content: { type: "string", description: "笔记的初始 Markdown 内容，省略则创建空笔记。" },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_file",
    description:
      "删除工作区中的一个文件或文件夹。执行前会向用户弹出确认卡片，用户批准后才真正删除。不确定路径时先用 search_notes 查找。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "要删除的文件或文件夹路径（相对工作区根目录或绝对路径）。" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "search_notes",
    description:
      "在工作区中按关键词搜索笔记：匹配文件名和文本内容（不区分大小写），返回命中文件路径、行号和内容片段。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键词。" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
];

export const isEditTool = (name: string) =>
  name === "edit_open_file" || name === "write_open_file";

/* --------------------------------- diff ---------------------------------- */

export interface DiffRow {
  type: "add" | "del";
  text: string;
}
export interface DiffView {
  added: number;
  removed: number;
  rows: DiffRow[];
}

/** Compact line diff: only the added/removed lines (unchanged lines dropped). */
export function computeLineDiff(before: string, after: string): DiffView {
  const rows: DiffRow[] = [];
  let added = 0;
  let removed = 0;
  for (const part of diffLines(before, after)) {
    if (!part.added && !part.removed) continue;
    const type = part.added ? "add" : "del";
    const lines = part.value.replace(/\n$/, "").split("\n");
    for (const text of lines) {
      rows.push({ type, text });
      if (type === "add") added++;
      else removed++;
    }
  }
  return { added, removed, rows };
}

/* --------------------------------- read ---------------------------------- */

export interface ReadResult {
  ok: boolean;
  path?: string;
  content?: string;
  error?: string;
}

/** Live content of the open text file (falls back to the persisted content). */
export function readOpenFile(): ReadResult {
  const state = useAppStore.getState();
  const path = state.activeFilePath;
  if (!path) return { ok: false, error: "当前没有打开任何文件。" };
  if (isImageFile(path)) return { ok: false, error: "当前打开的是图片，无法按文本读取。" };
  const view = getActiveView();
  const content = view ? view.state.doc.toString() : state.content;
  return { ok: true, path, content };
}

/** Read a workspace file by path; if it is open, prefer unsaved editor content. */
export async function readWorkspaceFile(args: Record<string, unknown>): Promise<ReadResult> {
  if (typeof args.path !== "string") return { ok: false, error: "read_file 需要 path 字符串。" };
  const resolved = resolveWorkspacePath(args.path);
  if (!resolved.ok) return resolved;

  const { activeFilePath, tree } = useAppStore.getState();
  if (resolved.path === activeFilePath) return readOpenFile();
  if (isImageFile(resolved.path)) return { ok: false, error: "目标文件是图片，无法按文本读取。" };

  const node = findNode(tree, resolved.path);
  if (node?.is_dir) return { ok: false, error: `「${args.path}」是文件夹，不能按文本读取。` };

  try {
    return { ok: true, path: resolved.path, content: await readFile(resolved.path) };
  } catch (e) {
    return {
      ok: false,
      error: typeof e === "string" ? e : (e as Error)?.message ?? "读取文件失败",
    };
  }
}

/* --------------------------------- edit ---------------------------------- */

export type PrepareResult =
  | { ok: true; summary: string; before: string; after: string; diff: DiffView }
  | { ok: false; error: string };

function replaceFirst(s: string, find: string, repl: string): string {
  const i = s.indexOf(find);
  return i < 0 ? s : s.slice(0, i) + repl + s.slice(i + find.length);
}

/** Compute the new document for an edit/write tool call without applying it. */
export function prepareEdit(name: string, args: Record<string, unknown>): PrepareResult {
  const state = useAppStore.getState();
  const path = state.activeFilePath;
  if (!path) return { ok: false, error: "当前没有打开任何文件，无法编辑。" };
  if (isImageFile(path)) return { ok: false, error: "当前打开的是图片，无法编辑文本。" };
  const view = getActiveView();
  if (!view) return { ok: false, error: "当前没有可编辑的文本编辑器。" };

  const before = view.state.doc.toString();
  let after: string;

  if (name === "write_open_file") {
    if (typeof args.content !== "string") return { ok: false, error: "write_open_file 需要 content 字符串。" };
    after = args.content;
  } else {
    const oldStr = args.old_string;
    const newStr = args.new_string;
    if (typeof oldStr !== "string" || typeof newStr !== "string")
      return { ok: false, error: "edit_open_file 需要 old_string 和 new_string 字符串。" };
    if (oldStr === "") return { ok: false, error: "old_string 不能为空。" };
    if (!before.includes(oldStr)) return { ok: false, error: "在当前文件中找不到 old_string，未做修改。" };
    after = args.replace_all === true ? before.split(oldStr).join(newStr) : replaceFirst(before, oldStr, newStr);
  }

  if (after === before) return { ok: false, error: "修改后内容与原文件相同，未做改动。" };
  return { ok: true, summary: basename(path), before, after, diff: computeLineDiff(before, after) };
}

/**
 * Replace the whole document in the active editor. The editor's own update
 * listener writes the change back to the store and marks it dirty; nothing is
 * saved to disk until the user does (Cmd+S). Returns false if no editor.
 */
export function applyContent(content: string): boolean {
  const view = getActiveView();
  if (!view) return false;
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } });
  return true;
}

/* --------------------------- workspace file tools ------------------------- */

type PathResult = { ok: true; path: string } | { ok: false; error: string };

/**
 * Resolve a model-provided path (workspace-relative or absolute) to a
 * normalized absolute path, rejecting anything outside the workspace so the
 * model can never touch files beyond it.
 */
function resolveWorkspacePath(p: string): PathResult {
  const ws = useAppStore.getState().workspacePath;
  if (!ws) return { ok: false, error: "当前没有打开工作区。" };
  const raw = p.trim();
  if (!raw) return { ok: false, error: "路径不能为空。" };
  const joined = raw.startsWith("/") ? raw : `${ws}/${raw}`;
  const parts: string[] = [];
  for (const seg of joined.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return { ok: false, error: "路径不在当前工作区内。" };
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  const norm = "/" + parts.join("/");
  if (norm !== ws && !norm.startsWith(ws + "/"))
    return { ok: false, error: "路径不在当前工作区内。" };
  return { ok: true, path: norm };
}

export type CreateNoteResult =
  | { ok: true; path: string; name: string }
  | { ok: false; error: string };

/** Create a markdown note (optionally with content), refresh and open it. */
export async function createNote(args: Record<string, unknown>): Promise<CreateNoteResult> {
  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (!name) return { ok: false, error: "create_note 需要 name 字符串。" };
  if (/[/\\]/.test(name)) return { ok: false, error: "name 不能包含路径分隔符，请用 dir 指定文件夹。" };

  const ws = useAppStore.getState().workspacePath;
  if (!ws) return { ok: false, error: "当前没有打开工作区。" };
  let dir = ws;
  if (typeof args.dir === "string" && args.dir.trim()) {
    const resolved = resolveWorkspacePath(args.dir);
    if (!resolved.ok) return resolved;
    dir = resolved.path;
  }

  try {
    const created = await createFile(dir, name);
    if (typeof args.content === "string" && args.content) {
      await writeFile(created, args.content);
    }
    const { refreshTree, openFile } = useAppStore.getState();
    await refreshTree();
    await openFile(created);
    return { ok: true, path: created, name: basename(created) };
  } catch (e) {
    return { ok: false, error: typeof e === "string" ? e : (e as Error)?.message ?? "创建失败" };
  }
}

export type PrepareDeleteResult =
  | { ok: true; path: string; name: string; isDir: boolean }
  | { ok: false; error: string };

/** Resolve and validate a delete target without deleting (for the confirm card). */
export function prepareDelete(args: Record<string, unknown>): PrepareDeleteResult {
  if (typeof args.path !== "string") return { ok: false, error: "delete_file 需要 path 字符串。" };
  const resolved = resolveWorkspacePath(args.path);
  if (!resolved.ok) return resolved;
  const { workspacePath, tree } = useAppStore.getState();
  if (resolved.path === workspacePath)
    return { ok: false, error: "不能删除工作区根目录。" };
  const node = findNode(tree, resolved.path);
  if (!node) return { ok: false, error: `找不到「${args.path}」，请先用 search_notes 确认路径。` };
  return { ok: true, path: node.path, name: node.name, isDir: node.is_dir };
}

export type SearchResult =
  | { ok: true; hits: SearchHit[] }
  | { ok: false; error: string };

/** Keyword search over the workspace (filenames + text content). */
export async function runSearch(args: Record<string, unknown>): Promise<SearchResult> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) return { ok: false, error: "search_notes 需要 query 关键词。" };
  const ws = useAppStore.getState().workspacePath;
  if (!ws) return { ok: false, error: "当前没有打开工作区。" };
  try {
    return { ok: true, hits: await searchNotes(ws, query) };
  } catch (e) {
    return { ok: false, error: typeof e === "string" ? e : (e as Error)?.message ?? "搜索失败" };
  }
}
