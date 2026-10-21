// Shared document scanning, with desktop-only file access below.
export * from "../../../share-service/renderer/lib/inputs/sources.ts";
import { tr } from "../../i18n/core.ts";
import { dirname, readFile } from "../fs";

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
  if (!path) return { ok: false, error: tr("无法解析路径「{{0}}」", { 0: ref }) };
  const root = workspacePath ?? (notePath ? dirname(notePath) : null);
  if (!isInside(root, path))
    return { ok: false, error: tr("「{{0}}」在工作区之外，出于安全考虑不会读取", { 0: ref }) };

  let text: string;
  try {
    text = await readFile(path);
  } catch (e) {
    return { ok: false, error: tr("读取失败：{{0}}", { 0: e }) };
  }
  if (text.length > MAX_INPUT_FILE_BYTES)
    return { ok: false, error: tr("文件超过 {{0}} MB", { 0: MAX_INPUT_FILE_BYTES / 1024 / 1024 }) };

  if (format === "json") {
    try {
      return { ok: true, path, data: JSON.parse(text) };
    } catch (e) {
      return { ok: false, error: tr("JSON 解析失败：{{0}}", { 0: e }) };
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
