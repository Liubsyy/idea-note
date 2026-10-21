// Where a code block's inputs come from: an ```input block, a markdown table
// in the same note, or a file next to it.
//
// Everything is located by scanning the document text rather than by a stored
// position — same reasoning as codeRun/document.ts. The note is the source of
// truth; nothing invisible is kept on the side.

import type { Text } from "@codemirror/state";

import {
  isCloseFenceFor,
  openingFenceOf,
  parseFenceInfo,
} from "../codeRun/fenceAttrs.ts";
import { parseInputBlock, type InputSchema } from "./schema.ts";

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
    const opening = openingFenceOf(line.text);
    if (!opening) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j <= doc.lines && !isCloseFenceFor(doc.line(j).text, opening)) j++;
    const closeLine = Math.min(j, doc.lines);
    if (!/^\s*input\s*(?:\{|$)/i.test(opening.info)) {
      i = closeLine + 1;
      continue;
    }
    ordinal++;
    const body =
      j > i + 1 ? doc.sliceString(doc.line(i + 1).from, doc.line(j - 1).to) : "";
    const attrs = parseFenceInfo(opening.info).attrs;
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

