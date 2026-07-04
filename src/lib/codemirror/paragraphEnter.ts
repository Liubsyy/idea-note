// Markdown-aware Enter key.
//
// In markdown a single "\n" is only a *soft* break (it collapses to a space
// when rendered by a real markdown engine); a real line break / new paragraph
// needs a blank line, i.e. two "\n". So when the cursor sits in ordinary
// paragraph (or heading) text, one Enter inserts a blank line, keeping the
// editor's visual line breaks in sync with what the exported markdown renders.
//
// List items, code blocks, blockquotes and table rows are line-oriented — there
// a single newline is the correct semantics — so in those contexts we defer to
// the stock Enter behavior by returning false.

import { syntaxTree } from "@codemirror/language";
import { EditorSelection, type EditorState } from "@codemirror/state";
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

function inSoftContext(state: EditorState, pos: number): boolean {
  for (
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1);
    node;
    node = node.parent
  ) {
    if (SOFT_CONTEXTS.has(node.name)) return true;
  }
  return false;
}

const insertParagraphBreak: Command = (view) => {
  const { state } = view;
  // Only the simple single-cursor case; selections / multi-cursor fall back to
  // the stock Enter so we never silently mangle a replacement or column edit.
  if (state.selection.ranges.length !== 1) return false;
  const range = state.selection.main;
  if (!range.empty) return false;
  if (inSoftContext(state, range.from)) return false;

  const line = state.doc.lineAt(range.from);
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
 * Highest-precedence Enter binding for markdown views. Returns false (so the
 * stock keymap's Enter still runs) whenever the cursor is in a line-oriented
 * block or the selection isn't a single empty caret.
 */
export const markdownParagraphEnter = keymap.of([
  { key: "Enter", run: insertParagraphBreak },
]);
