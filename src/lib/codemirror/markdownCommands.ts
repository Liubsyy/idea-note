// Toolbar actions that edit the markdown source in a CodeMirror view.
// Each operates on the active view and refocuses it afterwards.

import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { undo as cmUndo, redo as cmRedo } from "@codemirror/commands";

/** Wrap/unwrap the current selection with an inline delimiter (e.g. **). */
function toggleInline(view: EditorView, mark: string) {
  const { state } = view;
  const changes = state.changeByRange((range) => {
    const sel = state.sliceDoc(range.from, range.to);
    const before = state.sliceDoc(range.from - mark.length, range.from);
    const after = state.sliceDoc(range.to, range.to + mark.length);
    // Already wrapped -> unwrap.
    if (before === mark && after === mark) {
      return {
        changes: [
          { from: range.from - mark.length, to: range.from },
          { from: range.to, to: range.to + mark.length },
        ],
        range: EditorSelection.range(
          range.from - mark.length,
          range.to - mark.length,
        ),
      };
    }
    const insert = mark + sel + mark;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.range(
        range.from + mark.length,
        range.to + mark.length,
      ),
    };
  });
  view.dispatch(changes);
  view.focus();
}

/** Set or replace a line prefix (heading, quote, list) on each selected line. */
function setLinePrefix(
  view: EditorView,
  prefix: string,
  stripRe: RegExp,
) {
  const { state } = view;
  const lines = new Set<number>();
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    const b = state.doc.lineAt(r.to).number;
    for (let n = a; n <= b; n++) lines.add(n);
  }
  const changes = [];
  for (const n of lines) {
    const line = state.doc.line(n);
    const stripped = line.text.replace(stripRe, "");
    const oldPrefixLen = line.text.length - stripped.length;
    const already = line.text === prefix + stripped;
    changes.push({
      from: line.from,
      to: line.from + oldPrefixLen,
      insert: already ? "" : prefix,
    });
  }
  const changeSet = state.changes(changes);
  view.dispatch({
    changes: changeSet,
    // Map with assoc 1 so a cursor at line start lands after the new prefix.
    selection: state.selection.map(changeSet, 1),
  });
  view.focus();
}

/**
 * Insert a block template on its own line(s). Adds a leading newline unless the
 * cursor already sits on an empty line, and a trailing newline so the block is
 * self-contained. If `placeholder` is given and found in the block, it is left
 * selected so the user can type over it; otherwise the caret goes to the end.
 */
function insertBlock(view: EditorView, block: string, placeholder?: string) {
  const { state } = view;
  const range = state.selection.main;
  const line = state.doc.lineAt(range.from);
  const onEmptyLine = range.from === line.from && line.text.trim() === "";
  const lead = onEmptyLine ? "" : "\n";
  const insert = lead + block + "\n";
  const base = range.from + lead.length;
  const idx = placeholder ? block.indexOf(placeholder) : -1;
  const selection =
    idx >= 0
      ? EditorSelection.range(base + idx, base + idx + placeholder!.length)
      : EditorSelection.cursor(base + block.length);
  view.dispatch({ changes: { from: range.from, to: range.to, insert }, selection });
  view.focus();
}

const HEADING_RE = /^#{1,6}\s+/;
const QUOTE_RE = /^>\s+/;
const BULLET_RE = /^[-*+]\s+/;
const ORDERED_RE = /^\d+\.\s+/;
const PREFIX_RE = /^(#{1,6}|>|[-*+]|\d+\.)\s+/;

export const md = {
  bold: (v: EditorView) => toggleInline(v, "**"),
  italic: (v: EditorView) => toggleInline(v, "*"),
  strike: (v: EditorView) => toggleInline(v, "~~"),
  inlineCode: (v: EditorView) => toggleInline(v, "`"),

  heading: (v: EditorView, level: number) =>
    setLinePrefix(v, "#".repeat(level) + " ", PREFIX_RE),
  paragraph: (v: EditorView) => setLinePrefix(v, "", PREFIX_RE),
  quote: (v: EditorView) => setLinePrefix(v, "> ", QUOTE_RE),
  bulletList: (v: EditorView) => setLinePrefix(v, "- ", BULLET_RE),
  orderedList: (v: EditorView) => setLinePrefix(v, "1. ", ORDERED_RE),

  link: (v: EditorView, href: string, label?: string) => {
    const { state } = v;
    const changes = state.changeByRange((range) => {
      const text =
        label?.trim() || state.sliceDoc(range.from, range.to) || "链接";
      const insert = `[${text}](${href})`;
      return {
        changes: { from: range.from, to: range.to, insert },
        range: EditorSelection.cursor(range.from + insert.length),
      };
    });
    v.dispatch(changes);
    v.focus();
  },

  image: (v: EditorView, src: string, alt = "") => {
    const { state } = v;
    const changes = state.changeByRange((range) => {
      const insert = `![${alt.trim()}](${src})`;
      return {
        changes: { from: range.from, to: range.to, insert },
        range: EditorSelection.cursor(range.from + insert.length),
      };
    });
    v.dispatch(changes);
    v.focus();
  },

  codeBlock: (v: EditorView) => {
    const { state } = v;
    const range = state.selection.main;
    const sel = state.sliceDoc(range.from, range.to);
    const insert = "```\n" + sel + "\n```";
    v.dispatch({
      changes: { from: range.from, to: range.to, insert },
      selection: EditorSelection.cursor(range.from + 4),
    });
    v.focus();
  },

  table: (v: EditorView) =>
    insertBlock(
      v,
      "| 列1 | 列2 | 列3 |\n| --- | --- | --- |\n| 内容 | 内容 | 内容 |",
      "列1",
    ),
  taskList: (v: EditorView) => insertBlock(v, "- [ ] 待办事项", "待办事项"),
  mathBlock: (v: EditorView) => insertBlock(v, "$$\nE = mc^2\n$$", "E = mc^2"),
  mermaid: (v: EditorView, body: string) =>
    insertBlock(v, "```mermaid\n" + body + "\n```"),

  hr: (v: EditorView) => {
    const range = v.state.selection.main;
    v.dispatch({
      changes: { from: range.from, to: range.to, insert: "\n---\n" },
      selection: EditorSelection.cursor(range.from + 5),
    });
    v.focus();
  },

  undo: (v: EditorView) => {
    cmUndo(v);
    v.focus();
  },
  redo: (v: EditorView) => {
    cmRedo(v);
    v.focus();
  },
};

export { HEADING_RE, QUOTE_RE, BULLET_RE, ORDERED_RE };
