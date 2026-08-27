// Markdown-aware Enter key.
//
// In markdown a single "\n" is only a *soft* break (it collapses to a space
// when rendered by a real markdown engine); a real line break / new paragraph
// needs a blank line, i.e. two "\n". So when the cursor sits in ordinary
// paragraph (or heading) text, one Enter inserts a blank line, keeping the
// editor's visual line breaks in sync with what the exported markdown renders.
//
// Lists, code blocks and table rows are line-oriented, so those defer to the
// stock Enter behavior. A blockquote paragraph needs a quoted blank line to
// create a real paragraph break while remaining inside the quote. Backspace on
// that generated separator removes the whole line again, rather than deleting
// only `>` and leaving an accidental empty source line behind.

import { syntaxTree } from "@codemirror/language";
import { EditorSelection, Prec, type EditorState } from "@codemirror/state";
import { keymap, type Command } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";

/** Block contexts where a single "\n" is the right thing — keep stock Enter. */
const SOFT_CONTEXTS = new Set([
  "FencedCode",
  "CodeBlock",
  "Blockquote",
  "BulletList",
  "OrderedList",
  "ListItem",
  "Table",
]);

const QUOTE_ENTER_BLOCKERS = new Set([
  "FencedCode",
  "CodeBlock",
  "BulletList",
  "OrderedList",
  "ListItem",
  "Table",
]);

function inContext(state: EditorState, pos: number, names: Set<string>): boolean {
  for (
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1);
    node;
    node = node.parent
  ) {
    if (names.has(node.name)) return true;
  }
  return false;
}

function inSoftContext(state: EditorState, pos: number): boolean {
  return inContext(state, pos, SOFT_CONTEXTS);
}

const insertParagraphBreak: Command = (view) => {
  const { state } = view;
  // Only the simple single-cursor case; selections / multi-cursor fall back to
  // the stock Enter so we never silently mangle a replacement or column edit.
  if (state.selection.ranges.length !== 1) return false;
  const range = state.selection.main;
  if (!range.empty) return false;

  const line = state.doc.lineAt(range.from);
  const quotePrefix = line.text.match(/^\s*(?:>\s*)+/)?.[0] ?? null;
  if (
    quotePrefix &&
    inContext(state, range.from, new Set(["Blockquote"])) &&
    !inContext(state, range.from, QUOTE_ENTER_BLOCKERS)
  ) {
    const content = line.text.slice(quotePrefix.length);
    // On an empty quote line, defer so the stock Markdown command can end or
    // continue the quote naturally instead of accumulating empty paragraphs.
    if (!content.trim()) return false;

    // Keep the extension marker in its own Markdown paragraph as well. That
    // way an editor without highlight-block support shows the marker and body
    // separately instead of joining them into one line.
    const insert = `\n${quotePrefix.trimEnd()}\n${quotePrefix}`;
    view.dispatch(
      state.update({
        changes: { from: range.from, insert },
        selection: EditorSelection.cursor(range.from + insert.length),
        scrollIntoView: true,
        userEvent: "input",
      }),
    );
    return true;
  }

  if (inSoftContext(state, range.from)) return false;

  // On an already-blank line a single newline is enough — otherwise repeated
  // Enters would pile up blank lines.
  const insert = line.text.trim() === "" ? "\n" : "\n\n";

  view.dispatch(
    state.update({
      changes: { from: range.from, insert },
      selection: EditorSelection.cursor(range.from + insert.length),
      scrollIntoView: true,
      userEvent: "input",
    }),
  );
  return true;
};

/**
 * Collapse a quoted paragraph separator back to a single newline. The caret
 * must be at the end of a line containing only quote markers, so Backspace in
 * quote content (or before the marker) keeps CodeMirror's normal behaviour.
 */
const removeQuoteParagraphBreak: Command = (view) => {
  const { state } = view;
  if (state.selection.ranges.length !== 1) return false;
  const range = state.selection.main;
  if (!range.empty) return false;

  const line = state.doc.lineAt(range.from);
  if (range.from !== line.to || line.from === 0) return false;
  if (!/^\s*(?:>\s*)+$/.test(line.text)) return false;
  if (!inContext(state, range.from, new Set(["Blockquote"]))) return false;

  // Remove the newline before the separator together with its quote markers.
  // The newline after it remains, so the surrounding quote content becomes
  // adjacent source lines again and renders as a soft line break.
  const from = line.from - 1;
  view.dispatch(
    state.update({
      changes: { from, to: line.to },
      selection: EditorSelection.cursor(from),
      scrollIntoView: true,
      userEvent: "delete.backward",
    }),
  );
  return true;
};

/**
 * Highest-precedence Enter binding for markdown views. Returns false (so the
 * stock keymap's Enter still runs) whenever the cursor is in a line-oriented
 * block or the selection isn't a single empty caret.
 */
export const markdownParagraphEnter = Prec.highest(
  keymap.of([
    { key: "Enter", run: insertParagraphBreak },
    { key: "Backspace", run: removeQuoteParagraphBreak },
  ]),
);
