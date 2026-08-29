// Toolbar actions that edit the markdown source in a CodeMirror view.
// Each operates on the active view and refocuses it afterwards.

import { EditorSelection, type EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";
import { undo as cmUndo, redo as cmRedo } from "@codemirror/commands";

import {
  buildImageDest,
  buildImgTag,
  hasImageSize,
  isPlainImgTag,
  NO_IMAGE_SIZE,
  setImgAttr,
  wrapImageDest,
  type ImageSize,
  type ImgAttr,
} from "../imageSyntax";
import { imageAt } from "./imageAt";
import {
  highlightColorFromLine,
  highlightMarker,
  type HighlightColor,
} from "../highlightBlock";
import {
  findSpanAt,
  findSpansIn,
  serializeStyle,
  type SpanMatch,
} from "./spanStyle";

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

/**
 * Rewrite each span's open tag with its new style, dropping both tags when no
 * properties are left — so turning the last colour off leaves clean markdown
 * rather than an empty `<span>`.
 */
function rewriteSpans(
  view: EditorView,
  edits: { span: SpanMatch; style: Map<string, string> }[],
) {
  const { state } = view;
  const specs = [];
  for (const { span, style } of edits) {
    if (style.size === 0)
      specs.push(
        { from: span.openFrom, to: span.openTo },
        { from: span.closeFrom, to: span.closeTo },
      );
    else
      specs.push({
        from: span.openFrom,
        to: span.openTo,
        insert: `<span style="${serializeStyle(style)}">`,
      });
  }
  if (!specs.length) {
    view.focus();
    return;
  }
  const changes = state.changes(specs.sort((a, b) => a.from - b.from));
  view.dispatch({ changes, selection: state.selection.map(changes) });
  view.focus();
}

// Everything before a line's actual text: indent, list/quote/heading markers
// (possibly nested, as in `> - item`) and a task checkbox. Colouring has to
// start after it, or the marker stops being one.
const LINE_CONTENT_RE = /^\s*(?:(?:#{1,6}|>|[-*+]|\d+\.)\s+)*(?:\[[ xX]\]\s+)?/;
// Lines a multi-line selection colours around rather than through: blanks,
// table rows and code fences, where a `<span>` would break the block.
const SKIP_LINE_RE = /^\s*(?:\||```|~~~|$)/;

/** Is `pos` inside a code block? Colouring there would put literal `<span>`
 *  markup into the code rather than styling it. */
function insideCode(state: EditorState, pos: number): boolean {
  for (
    let node = syntaxTree(state).resolveInner(pos, 1) as ReturnType<
      typeof syntaxTree
    >["topNode"] | null;
    node;
    node = node.parent
  )
    if (node.name === "FencedCode" || node.name === "CodeBlock") return true;
  return false;
}

/**
 * Colour a selection spanning several lines by wrapping each line's text in its
 * own span. One span across the whole range would swallow the blank lines and
 * table rows between blocks, which stops them parsing as markdown.
 */
function setSpanStyleLines(
  view: EditorView,
  prop: string,
  value: string,
  from: number,
  to: number,
) {
  const { state } = view;
  const open = `<span style="${prop}: ${value}">`;
  const specs = [];
  const last = state.doc.lineAt(to).number;
  for (let n = state.doc.lineAt(from).number; n <= last; n++) {
    const line = state.doc.line(n);
    if (SKIP_LINE_RE.test(line.text) || insideCode(state, line.from)) continue;
    const prefix = LINE_CONTENT_RE.exec(line.text);
    const segFrom = Math.max(from, line.from + (prefix ? prefix[0].length : 0));
    const segTo = Math.min(to, line.to);
    if (segFrom >= segTo) continue;
    specs.push({ from: segFrom, insert: open }, { from: segTo, insert: "</span>" });
  }
  if (!specs.length) {
    view.focus();
    return;
  }
  const changes = state.changes(specs);
  view.dispatch({
    changes,
    // Keep the same text selected: past the first open tag, before the last close.
    selection: EditorSelection.range(
      changes.mapPos(from, 1),
      changes.mapPos(to, -1),
    ),
  });
  view.focus();
}

/**
 * Set a `<span>` style property on the selection. Inside an existing span the
 * property is merged into it (and toggled off when it already holds `value`);
 * otherwise the selection is wrapped in a new span. With an empty selection an
 * empty span is inserted with the caret between its tags, ready to type into.
 */
function setSpanStyle(view: EditorView, prop: string, value: string) {
  const { state } = view;
  const range = state.selection.main;
  if (state.doc.lineAt(range.from).number !== state.doc.lineAt(range.to).number) {
    setSpanStyleLines(view, prop, value, range.from, range.to);
    return;
  }
  const span = findSpanAt(state, range.from, range.to);
  if (span) {
    const style = new Map(span.style);
    if (style.get(prop)?.toLowerCase() === value.toLowerCase())
      style.delete(prop);
    else style.set(prop, value);
    rewriteSpans(view, [{ span, style }]);
    return;
  }
  const text = state.sliceDoc(range.from, range.to);
  const open = `<span style="${prop}: ${value}">`;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: open + text + "</span>" },
    selection: EditorSelection.range(
      range.from + open.length,
      range.from + open.length + text.length,
    ),
  });
  view.focus();
}

/**
 * Drop both colour properties: from the span around the cursor, or — when the
 * selection covers several lines — from every span inside it.
 */
function clearSpanColors(view: EditorView) {
  const { state } = view;
  const range = state.selection.main;
  const multiLine =
    state.doc.lineAt(range.from).number !== state.doc.lineAt(range.to).number;
  const spans = multiLine
    ? findSpansIn(state, range.from, range.to)
    : [findSpanAt(state, range.from, range.to)].filter((s) => s !== null);
  rewriteSpans(
    view,
    spans.map((span) => {
      const style = new Map(span.style);
      style.delete("color");
      style.delete("background-color");
      return { span, style };
    }),
  );
}

const HEADING_RE = /^#{1,6}\s+/;
const QUOTE_RE = /^>\s+/;
const BULLET_RE = /^[-*+]\s+/;
const ORDERED_RE = /^\d+\.\s+/;
const PREFIX_RE = /^(#{1,6}|>|[-*+]|\d+\.)\s+/;
const QUOTED_LINE_RE = /^\s*>/;

/** Find the highlight block containing `pos`, if any. */
function highlightBlockAt(state: EditorState, pos: number) {
  const lineNumber = state.doc.lineAt(pos).number;
  let first = lineNumber;
  while (first > 1 && QUOTED_LINE_RE.test(state.doc.line(first - 1).text))
    first--;

  const color = highlightColorFromLine(state.doc.line(first).text);
  if (!color) return null;

  let last = first;
  while (
    last < state.doc.lines &&
    QUOTED_LINE_RE.test(state.doc.line(last + 1).text)
  )
    last++;

  return lineNumber <= last ? { first, last, color } : null;
}

/**
 * Insert a highlight block, wrap the selected lines, or unwrap the highlight
 * block under the cursor. The source remains an ordinary Markdown blockquote,
 * so other editors still show readable content even without this extension.
 */
function editHighlightBlock(
  view: EditorView,
  color: HighlightColor,
  toggleCurrent: boolean,
) {
  const { state } = view;
  const range = state.selection.main;
  const current = highlightBlockAt(state, range.head);

  if (current) {
    const marker = state.doc.line(current.first);
    if (!toggleCurrent) {
      const insert = highlightMarker(color);
      const changeSet = state.changes({
        from: marker.from,
        to: marker.to,
        insert,
      });
      view.dispatch({
        changes: changeSet,
        selection: state.selection.map(changeSet),
        userEvent: "input",
      });
      view.focus();
      return;
    }
    const changes: { from: number; to?: number; insert?: string }[] = [];
    if (marker.to < state.doc.length) {
      changes.push({ from: marker.from, to: marker.to + 1 });
    } else {
      changes.push({ from: marker.from, to: marker.to });
    }
    let contentStart = current.first + 1;
    if (contentStart <= current.last) {
      const separator = state.doc.line(contentStart);
      if (/^\s*(?:>\s*)+$/.test(separator.text)) {
        // New highlight blocks keep the extension marker in its own Markdown
        // paragraph. Remove that structural separator together with the marker
        // when unwrapping so it does not turn into a leading blank line.
        changes.push({
          from: separator.from,
          to:
            separator.to < state.doc.length
              ? separator.to + 1
              : separator.to,
        });
        contentStart++;
      }
    }
    for (let n = contentStart; n <= current.last; n++) {
      const line = state.doc.line(n);
      const prefix = line.text.match(/^(\s*)>\s?/);
      if (prefix)
        changes.push({
          from: line.from + prefix[1].length,
          to: line.from + prefix[0].length,
        });
    }
    const changeSet = state.changes(changes);
    view.dispatch({
      changes: changeSet,
      selection: state.selection.map(changeSet),
      userEvent: "input",
    });
    view.focus();
    return;
  }

  if (range.empty) {
    insertBlock(
      view,
      `${highlightMarker(color)}\n>\n> 高亮内容`,
      "高亮内容",
    );
    return;
  }

  const startLine = state.doc.lineAt(range.from).number;
  const rawEndLine = state.doc.lineAt(range.to);
  const endLine =
    range.to > range.from && range.to === rawEndLine.from
      ? rawEndLine.number - 1
      : rawEndLine.number;
  const changes = [];
  for (let n = startLine; n <= endLine; n++) {
    const line = state.doc.line(n);
    changes.push({
      from: line.from,
      insert:
        n === startLine ? `${highlightMarker(color)}\n>\n> ` : "> ",
    });
  }
  const changeSet = state.changes(changes);
  view.dispatch({
    changes: changeSet,
    selection: state.selection.map(changeSet, 1),
    userEvent: "input",
  });
  view.focus();
}

export const md = {
  bold: (v: EditorView) => toggleInline(v, "**"),
  italic: (v: EditorView) => toggleInline(v, "*"),
  strike: (v: EditorView) => toggleInline(v, "~~"),
  inlineCode: (v: EditorView) => toggleInline(v, "`"),

  textColor: (v: EditorView, color: string) => setSpanStyle(v, "color", color),
  bgColor: (v: EditorView, color: string) =>
    setSpanStyle(v, "background-color", color),
  clearColor: (v: EditorView) => clearSpanColors(v),

  heading: (v: EditorView, level: number) =>
    setLinePrefix(v, "#".repeat(level) + " ", PREFIX_RE),
  paragraph: (v: EditorView) => setLinePrefix(v, "", PREFIX_RE),
  quote: (v: EditorView) => setLinePrefix(v, "> ", QUOTE_RE),
  highlightBlock: (v: EditorView) => editHighlightBlock(v, "blue", true),
  highlightBlockColor: (v: EditorView, color: HighlightColor) =>
    editHighlightBlock(v, color, false),
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

  /**
   * Insert an image, or rewrite the one under the cursor when there is one —
   * the toolbar's image button doubles as "edit this image".
   *
   * A size means an `<img>` tag, the only sizing every markdown renderer
   * honours; without one the image goes back to plain `![alt](…)`. Editing an
   * existing tag keeps its own attributes (and stays a tag if it has any this
   * app doesn't write), so a hand-written `<img class=… style=…>` survives.
   */
  image: (
    v: EditorView,
    src: string,
    alt = "",
    size: ImageSize = NO_IMAGE_SIZE,
  ) => {
    const { state } = v;
    const current = imageAt(state, state.selection.main.head);
    const url = src.trim();
    const title = current?.title ?? "";
    const label = alt.trim();
    const asTag = current?.kind === "html" && !isPlainImgTag(current.attrs);
    let insert: string;
    if (hasImageSize(size) || asTag) {
      let attrs: ImgAttr[] = current?.kind === "html" ? current.attrs : [];
      attrs = setImgAttr(attrs, "src", url);
      attrs = setImgAttr(attrs, "alt", label);
      attrs = setImgAttr(attrs, "title", title);
      attrs = setImgAttr(attrs, "width", size.width);
      attrs = setImgAttr(attrs, "height", size.height);
      insert = buildImgTag(attrs);
    } else {
      // The destination is only re-derived when the path itself changed, so an
      // existing note keeps the `<…>` form paste and attachments write.
      const dest =
        current?.kind === "markdown" && current.url === url
          ? current.dest
          : wrapImageDest(url);
      insert = `![${label}](${buildImageDest(dest, title)})`;
    }
    if (current) {
      v.dispatch({
        changes: { from: current.from, to: current.to, insert },
        selection: EditorSelection.cursor(current.from + insert.length),
      });
      v.focus();
      return;
    }
    const changes = state.changeByRange((range) => ({
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.cursor(range.from + insert.length),
    }));
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
  /** A ready-made 可交互组件 (input block + fence), built by the toolbar dialog. */
  codeComponent: (v: EditorView, snippet: string) => insertBlock(v, snippet),

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
