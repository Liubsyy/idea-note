// Where a code block's inputs come from: an ```input block, a markdown table
// in the same note, or a file next to it.
//
// Everything is located by scanning the document text rather than by a stored
// position — same reasoning as codeRun/document.ts. The note is the source of
// truth; nothing invisible is kept on the side.

import type { Text } from "@codemirror/state";

import {
  INPUT_FENCE,
  fenceInfoOf,
  isCloseFenceLine,
  parseFenceInfo,
} from "../codeRun/fenceAttrs";
import { parseInputBlock, type InputSchema } from "./schema";
import { dirname, readFile } from "../fs";

export interface InputBlockInfo {
  /** `id=…` when given, else the block's ordinal (`1`, `2`, …). Ordinals stay
   *  stable while the body is edited, which a content hash would not. */
  id: string;
  /** Whether the id came from `id=…` — an unnamed block can't be bound to. */
  named: boolean;
  /** Document offsets of the whole block, fences included. */
  from: number;
  to: number;
  source: string;
  schema: InputSchema;
}

/** Every ```input block in the document, in order. */
export function scanInputBlocks(doc: Text): InputBlockInfo[] {
  const blocks: InputBlockInfo[] = [];
  let ordinal = 0;
  let i = 1;
  while (i <= doc.lines) {
    const line = doc.line(i);
    if (!INPUT_FENCE.test(line.text)) {
      i++;
      continue;
    }
    ordinal++;
    let j = i + 1;
    while (j <= doc.lines && !isCloseFenceLine(doc.line(j).text)) j++;
    const closeLine = Math.min(j, doc.lines);
    const body =
      j > i + 1 ? doc.sliceString(doc.line(i + 1).from, doc.line(j - 1).to) : "";
    const attrs = parseFenceInfo(fenceInfoOf(line.text) ?? "").attrs;
    blocks.push({
      id: attrs.id ?? String(ordinal),
      named: attrs.id !== null,
      from: line.from,
      to: doc.line(closeLine).to,
      source: body,
      schema: parseInputBlock(body),
    });
    i = closeLine + 1;
  }
  return blocks;
}

export const findInputBlock = (doc: Text, id: string): InputBlockInfo | null =>
  scanInputBlocks(doc).find((b) => b.id === id) ?? null;

/* ------------------------------- tables -------------------------------- */

const isTableRow = (text: string) => /^\s*\|.*\|\s*$/.test(text);

const splitRow = (text: string): string[] =>
  text
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());

const isSeparatorRow = (text: string) =>
  isTableRow(text) && splitRow(text).every((c) => /^:?-+:?$/.test(c));

export interface TableData {
  columns: string[];
  rows: string[][];
}

function readTableAt(doc: Text, start: number): TableData | null {
  if (start + 1 > doc.lines) return null;
  if (!isTableRow(doc.line(start).text)) return null;
  if (start + 1 > doc.lines || !isSeparatorRow(doc.line(start + 1).text)) return null;
  const columns = splitRow(doc.line(start).text);
  const rows: string[][] = [];
  for (let n = start + 2; n <= doc.lines && isTableRow(doc.line(n).text); n++) {
    rows.push(splitRow(doc.line(n).text));
  }
  return { columns, rows };
}

/**
 * The table introduced by `name` — either the heading above it (`## 销售数据`)
 * or a plain line holding just that text. Blank lines between the two are
 * allowed; anything else ends the search, so a name never reaches across a
 * section into an unrelated table.
 */
export function findTable(doc: Text, name: string): TableData | null {
  const wanted = name.trim();
  for (let i = 1; i <= doc.lines; i++) {
    const text = doc.line(i).text.trim();
    const label = text.replace(/^#{1,6}\s*/, "").replace(/\*\*/g, "").trim();
    if (label !== wanted) continue;
    for (let j = i + 1; j <= doc.lines; j++) {
      const next = doc.line(j).text.trim();
      if (!next) continue;
      if (!isTableRow(next)) break;
      return readTableAt(doc, j);
    }
  }
  return null;
}

/* -------------------------------- files -------------------------------- */

/** Collapse "." / ".." (expects "/" separators); mirrors imagePath.ts. */
function normalize(p: string): string {
  const drive = /^[a-zA-Z]:\//.test(p) ? p.slice(0, 2) : "";
  const stack: string[] = [];
  for (const seg of (drive ? p.slice(2) : p).split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") stack.pop();
    else stack.push(seg);
  }
  return drive + "/" + stack.join("/");
}

const isAbsolute = (p: string) => p.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(p);

/** Resolve a note-relative path to an absolute one. */
export function resolvePath(notePath: string | null, ref: string): string | null {
  const raw = ref.trim().replace(/\\/g, "/");
  if (!raw) return null;
  if (isAbsolute(raw)) return normalize(raw);
  if (!notePath) return null;
  return normalize(`${dirname(notePath).replace(/\\/g, "/")}/${raw}`);
}

/** Whether `path` sits inside `root`. Both are already normalized. */
export function isInside(root: string | null, path: string): boolean {
  if (!root) return false;
  const base = normalize(root.replace(/\\/g, "/")).replace(/\/$/, "");
  return path === base || path.startsWith(`${base}/`);
}

/**
 * RFC-4180-ish CSV: quoted fields, doubled quotes, CR/LF line endings. Enough
 * for the spreadsheet exports these blocks actually get pointed at.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || r[0] !== "");
}

/** Largest file a block will pull into its input payload. */
export const MAX_INPUT_FILE_BYTES = 2 * 1024 * 1024;

export type FileLoad =
  | { ok: true; path: string; data: unknown }
  | { ok: false; error: string };

/**
 * Read a data file for a block.
 *
 * Reading is restricted to the workspace (or, for an unsaved note, the note's
 * own folder): a block in a synced repository must not be able to name
 * `~/.ssh/id_rsa` and have the script print it.
 */
export async function loadFile(
  notePath: string | null,
  ref: string,
  format: "csv" | "json" | "text",
  workspacePath: string | null,
): Promise<FileLoad> {
  const path = resolvePath(notePath, ref);
  if (!path) return { ok: false, error: `无法解析路径「${ref}」` };
  const root = workspacePath ?? (notePath ? dirname(notePath) : null);
  if (!isInside(root, path))
    return { ok: false, error: `「${ref}」在工作区之外，出于安全考虑不会读取` };

  let text: string;
  try {
    text = await readFile(path);
  } catch (e) {
    return { ok: false, error: `读取失败：${e}` };
  }
  if (text.length > MAX_INPUT_FILE_BYTES)
    return { ok: false, error: `文件超过 ${MAX_INPUT_FILE_BYTES / 1024 / 1024} MB` };

  if (format === "json") {
    try {
      return { ok: true, path, data: JSON.parse(text) };
    } catch (e) {
      return { ok: false, error: `JSON 解析失败：${e}` };
    }
  }
  if (format === "csv") {
    const rows = parseCsv(text);
    const [header = [], ...body] = rows;
    return {
      ok: true,
      path,
      data: body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""]))),
    };
  }
  return { ok: true, path, data: text };
}
