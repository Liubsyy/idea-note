// Finding a run's code block again in the open document, and writing its
// output back into the note.
//
// Records identify a block by its *content*, not by a position (see
// useRunStore), so both operations locate the block by searching the document
// for the exact source that was run. A block whose code has since been edited
// simply isn't found — which is the right answer: that result no longer
// describes anything in the note.

import { syntaxTree } from "@codemirror/language";
import { EditorView } from "@codemirror/view";

import { getActiveView } from "../codemirror/activeView";
import type { RunRecord } from "../../store/useRunStore";

/** A closing ``` / ~~~ fence line, with nothing after it. */
const CLOSE_FENCE = /^\s*(`{3,}|~{3,})\s*$/;
/** An opening fence whose info string is exactly `output`. */
const OUTPUT_FENCE = /^\s*(`{3,}|~{3,})\s*output\s*$/i;

interface BlockSpan {
  /** Offset of the first character of the code body. */
  from: number;
  /** End offset of the block's closing fence line. */
  fenceEnd: number;
}

function locate(view: EditorView, code: string): BlockSpan | null {
  const doc = view.state.doc;
  const from = doc.toString().indexOf(code);
  if (from < 0) return null;
  const bodyEnd = doc.lineAt(from + code.length);
  const next = bodyEnd.number + 1;
  // The line after the body must be the closing fence, or this match isn't the
  // fenced block we ran (it could be prose quoting the same text).
  if (next > doc.lines || !CLOSE_FENCE.test(doc.line(next).text)) return null;
  return { from, fenceEnd: doc.line(next).to };
}

/** Move the caret to a record's code block and scroll it into view. */
export function revealBlock(record: RunRecord): boolean {
  const view = getActiveView();
  if (!view) return false;
  const span = locate(view, record.code);
  if (!span) return false;
  view.dispatch({
    selection: { anchor: span.from },
    effects: EditorView.scrollIntoView(span.from, { y: "center" }),
  });
  view.focus();
  return true;
}

/** The output as plain text, both streams in the order they arrived. */
export const outputText = (record: RunRecord): string =>
  record.segs.map((s) => s.text).join("").replace(/\s+$/, "");

/**
 * Write a record's output into the note as an ```output block right after its
 * code block, replacing the one already there.
 *
 * The convention is positional — "the output block immediately after a code
 * block belongs to it" — so nothing invisible has to be stored in the file.
 */
export function insertOutput(record: RunRecord): boolean {
  const view = getActiveView();
  if (!view || view.state.readOnly) return false;
  const span = locate(view, record.code);
  if (!span) return false;

  const doc = view.state.doc;
  let to = span.fenceEnd;
  let line = doc.lineAt(span.fenceEnd).number + 1;
  // Allow one blank line between the code block and its output block.
  if (line <= doc.lines && doc.line(line).text.trim() === "") line++;
  if (line <= doc.lines && OUTPUT_FENCE.test(doc.line(line).text)) {
    let end = line + 1;
    while (end <= doc.lines && !CLOSE_FENCE.test(doc.line(end).text)) end++;
    to = doc.line(Math.min(end, doc.lines)).to;
  }

  const body = outputText(record);
  view.dispatch({
    changes: { from: span.fenceEnd, to, insert: `\n\n\`\`\`output\n${body}\n\`\`\`` },
  });
  return true;
}

/** The fenced code block containing `pos`, or null when there isn't one. Used
 *  by the editor's context menu ("在终端运行"). */
export function codeBlockAt(
  view: EditorView,
  pos: number,
): { info: string; code: string } | null {
  let node = syntaxTree(view.state).resolveInner(pos, 0);
  while (node.name !== "FencedCode") {
    const parent = node.parent;
    if (!parent) return null;
    node = parent;
  }
  const doc = view.state.doc;
  const open = doc.lineAt(node.from);
  const end = doc.lineAt(node.to);
  const info = open.text.match(/^\s*(?:`{3,}|~{3,})\s*([^\s`]*)/)?.[1] ?? "";
  const lines: string[] = [];
  for (let n = open.number + 1; n <= end.number; n++) {
    const text = doc.line(n).text;
    if (n === end.number && CLOSE_FENCE.test(text)) break;
    lines.push(text);
  }
  const code = lines.join("\n").replace(/\s+$/, "");
  return code.trim() ? { info, code } : null;
}
