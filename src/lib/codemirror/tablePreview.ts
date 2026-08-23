// GFM table live preview for CodeMirror 6.
//
// A markdown table spans several lines, so rendering it as a real <table>
// means replacing those lines with a block widget. Block decorations that
// cover line breaks must come from a StateField (a ViewPlugin may not), which
// is why this lives apart from livePreview.ts.
//
// The table stays rendered while it is edited: clicking a cell parks a
// <textarea> over that cell holding its markdown source, and every keystroke is
// written straight back into the cell's document range, so undo, auto-save and
// the outline keep seeing a normal edit. The cell underneath holds the same raw
// text painted transparent — that is what keeps the column sized to the text
// being typed. The raw table source only appears after the explicit button in
// the table's top-right corner is pressed. Pointer, keyboard and search
// selections must not reveal it implicitly; this keeps stray selection changes
// from un-rendering a table after repeated clicks.

import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { redo, undo } from "@codemirror/commands";
import {
  EditorState,
  Range,
  StateEffect,
  StateField,
  type Extension,
} from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";

import { parseAdvanced } from "./livePreview";
import { renderInlineHtml, sanitizeHtml } from "./inlineHtml";
import { openLinkTargetSafe } from "./linkClick";

type Align = "left" | "center" | "right" | "";

/** A cell's trimmed text plus the document range that text occupies. */
type Cell = { text: string; from: number; to: number };

/** One row's source line, as a document range. */
type Line = { from: number; to: number };

/** A parsed table: row 0 is the header, row 1 the delimiter, 2+ the body. */
type TableModel = {
  rows: Cell[][];
  lines: Line[];
  align: Align[];
  /** Column count, taken from the header row. */
  cols: number;
};

/** Index of the `---|---` row, which has no rendered cells to edit. */
const DELIM_ROW = 1;

const EMPTY_MODEL: TableModel = { rows: [], lines: [], align: [], cols: 0 };

const isSpace = (ch: string): boolean => /\s/.test(ch);

/**
 * Trim a raw `| … |` span down to its text, keeping the document range that
 * text occupies. An all-whitespace span collapses to an empty range at its end,
 * which is where typing into an empty cell inserts.
 */
function cellAt(text: string, base: number, from: number, to: number): Cell {
  let start = from;
  let end = to;
  while (start < end && isSpace(text[start])) start++;
  while (end > start && isSpace(text[end - 1])) end--;
  // An empty cell is all padding: aim between its spaces, so typing into one
  // keeps the row shaped like `| x |` instead of `|  x|`.
  if (start === end && to > from) start = end = Math.min(from + 1, to);
  return { text: text.slice(start, end), from: base + start, to: base + end };
}

/**
 * Split a "| a | b |" row into cells, each carrying the document range of its
 * text so an edit can be written back. Per GFM, a `\|` is a literal pipe inside
 * the cell, not a separator; the backslash stays in the cell text so
 * renderInlineHtml's escape handling (`\x` -> `x`) unwraps it.
 */
function parseRow(text: string, base: number): Cell[] {
  const cells: Cell[] = [];
  let i = 0;
  let end = text.length;
  // Ignore the row's outer whitespace, so a trailing "  " isn't read as a cell.
  while (i < end && isSpace(text[i])) i++;
  while (end > i && isSpace(text[end - 1])) end--;
  if (text[i] === "|") i++; // an outer pipe fences the row, it doesn't split it
  let start = i;
  let closed = false; // row ended right after an unescaped `|`
  for (; i < end; i++) {
    if (text[i] === "\\" && i + 1 < end) {
      i++;
      closed = false;
    } else if (text[i] === "|") {
      cells.push(cellAt(text, base, start, i));
      start = i + 1;
      closed = true;
    } else {
      closed = false;
    }
  }
  if (!closed) cells.push(cellAt(text, base, start, end));
  return cells;
}

/** Read column alignment from the delimiter row (e.g. `:---`, `:--:`, `--:`). */
function parseAlign(cells: Cell[]): Align[] {
  return cells.map((cell) => {
    const left = cell.text.startsWith(":");
    const right = cell.text.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return "";
  });
}

/** Parse the table source starting at document offset `base`. */
function parseTable(source: string, base: number): TableModel {
  const rows: Cell[][] = [];
  const lines: Line[] = [];
  let offset = 0;
  for (const text of source.split("\n")) {
    const from = base + offset;
    offset += text.length + 1;
    // A blank line ends a GFM table; skipping one defensively keeps the row
    // indexes an in-place edit is pinned to in step with the rendered rows.
    if (text.trim() === "") continue;
    lines.push({ from, to: from + text.length });
    rows.push(parseRow(text, from));
  }
  return {
    rows,
    lines,
    align: rows.length > DELIM_ROW ? parseAlign(rows[DELIM_ROW]) : [],
    cols: rows.length ? rows[0].length : 0,
  };
}

/**
 * Append `count` empty cells to a row line. A row that doesn't end in `|` is
 * closed first, because GFM (and parseRow) drop one trailing pipe as the row's
 * fence rather than reading it as an extra cell.
 */
function padCells(line: string, count: number): string {
  const closed = line.replace(/\s+$/, "").endsWith("|");
  return (closed ? "" : " |") + "  |".repeat(count);
}

/**
 * Keep typed text usable as one table cell: a bare `|` would split the row, and
 * a pasted newline would break the table apart. Returns the caret position
 * mapped onto the rewritten text.
 */
function sanitizeCellInput(
  value: string,
  caret: number,
): { text: string; caret: number } {
  let text = "";
  let mapped = caret;
  let slashes = 0; // unbroken backslashes right before the current character
  for (let i = 0; i <= value.length; i++) {
    if (i === caret) mapped = text.length;
    if (i === value.length) break;
    const ch = value[i];
    if (ch === "\n" || ch === "\r") {
      text += " ";
      slashes = 0;
      continue;
    }
    text += ch === "|" && slashes % 2 === 0 ? "\\|" : ch;
    slashes = ch === "\\" ? slashes + 1 : 0;
  }
  return { text, caret: mapped };
}

/** Render a cell's inline markdown + HTML into `el` (sanitized). */
function renderCell(text: string, el: HTMLElement): void {
  el.innerHTML = sanitizeHtml(renderInlineHtml(text));
}

/**
 * A column is "wide" (and thus allowed to wrap) once its widest cell exceeds
 * this many visual units. Below it, the column is treated as a label/number
 * column and kept on a single line. CJK characters count as ~2 units since they
 * render roughly double-width.
 */
const WRAP_THRESHOLD = 32;

/** Approximate on-screen width of a string, counting CJK glyphs as double-width. */
function visualLen(s: string): number {
  let n = 0;
  for (const ch of s) {
    n += /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-鿿가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(
      ch,
    )
      ? 2
      : 1;
  }
  return n;
}

/**
 * Which columns may wrap: the widest cell sets the column width, so a long
 * column gives up space and wraps while narrow (label/number) columns stay on
 * a single line. Tagged via cm-md-cell-wrap; the rest default to nowrap.
 */
function wrapColumns(model: TableModel): boolean[] {
  const wraps: boolean[] = [];
  for (let col = 0; col < model.cols; col++) {
    let width = 0;
    for (let row = 0; row < model.rows.length; row++) {
      if (row === DELIM_ROW) continue;
      width = Math.max(width, visualLen(model.rows[row][col]?.text ?? ""));
    }
    wraps.push(width > WRAP_THRESHOLD);
  }
  return wraps;
}

// ---------------------------------------------------------------------------
// In-place cell editing
// ---------------------------------------------------------------------------

/** The cell being edited in place, addressed by its table's start offset. */
type CellEdit = { table: number; row: number; col: number; caret: number };

const setCellEdit = StateEffect.define<CellEdit | null>();

/** A table whose raw markdown was explicitly revealed with its source button. */
type SourceTable = { from: number; to: number };

const setSourceTable = StateEffect.define<SourceTable | null>();

const cellEditField = StateField.define<CellEdit | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setCellEdit)) return e.value;
    if (!value) return null;
    // An explicit selection change means focus went back to the editor itself
    // (a click, typing, a search hit), which ends the in-place edit.
    if (tr.selection) return null;
    // Otherwise keep pointing at the same table when text above it changes.
    return tr.docChanged
      ? { ...value, table: tr.changes.mapPos(value.table, 1) }
      : value;
  },
});

const sourceTableField = StateField.define<SourceTable | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects)
      if (effect.is(setSourceTable)) return effect.value;
    if (!value) return null;
    if (tr.startState.readOnly !== tr.state.readOnly && tr.state.readOnly)
      return null;
    const mapped = tr.docChanged
      ? {
          // Include edits inserted exactly at either table boundary.
          from: tr.changes.mapPos(value.from, -1),
          to: tr.changes.mapPos(value.to, 1),
        }
      : value;
    // Keep explicit source mode while editing anywhere inside this table. Once
    // every selection leaves it, return to the rendered widget.
    if (
      tr.selection &&
      !tr.state.selection.ranges.some(
        (range) => range.from <= mapped.to && range.to >= mapped.from,
      )
    )
      return null;
    return mapped;
  },
});

/**
 * Mutable state shared by one widget's DOM and its handlers. The <textarea>
 * outlives the widget instances (every keystroke builds a new one), so its
 * handlers read the table model from here instead of closing over a snapshot
 * that goes stale after the first edit.
 */
type CellHost = {
  view: EditorView;
  block: HTMLElement;
  wrap: HTMLElement;
  table: HTMLTableElement;
  model: TableModel;
  edit: CellEdit | null;
  input: HTMLTextAreaElement | null;
  composing: boolean;
  press: { x: number; y: number } | null;
  resize: ResizeObserver | null;
};

const hosts = new WeakMap<HTMLElement, CellHost>();

const setCaret = (input: HTMLTextAreaElement, at: number): void =>
  input.setSelectionRange(at, at);

const atStart = (input: HTMLTextAreaElement): boolean =>
  input.selectionStart === 0 && input.selectionEnd === 0;

const atEnd = (input: HTMLTextAreaElement): boolean =>
  input.selectionStart === input.value.length &&
  input.selectionEnd === input.value.length;

/** Next editable row in `dir`, skipping the delimiter. Null at either end. */
function stepRow(model: TableModel, row: number, dir: 1 | -1): number | null {
  let next = row + dir;
  if (next === DELIM_ROW) next += dir;
  return next >= 0 && next < model.rows.length ? next : null;
}

/** Next editable cell in `dir`, wrapping into the neighbouring row. */
function stepCell(
  model: TableModel,
  row: number,
  col: number,
  dir: 1 | -1,
): { row: number; col: number } | null {
  const next = col + dir;
  if (next >= 0 && next < model.cols) return { row, col: next };
  const wrapRow = stepRow(model, row, dir);
  if (wrapRow === null) return null;
  return { row: wrapRow, col: dir > 0 ? 0 : model.cols - 1 };
}

function cellElement(
  table: HTMLTableElement,
  row: number,
  col: number,
): HTMLTableCellElement | null {
  const tr =
    row === 0
      ? table.tHead?.rows[0]
      : table.tBodies[0]?.rows[row - DELIM_ROW - 1];
  return tr?.cells[col] ?? null;
}

/** Move the in-place edit to a cell, creating its source if the row is short. */
function startEdit(
  host: CellHost,
  row: number,
  col: number,
  caret: number | null,
): void {
  const { view } = host;
  if (row === DELIM_ROW || !host.model.rows[row]) return;
  // A row shorter than the header has no source for its trailing cells; give
  // it empty ones so there is something to write into.
  const missing = col + 1 - host.model.rows[row].length;
  if (missing > 0) {
    const line = host.model.lines[row];
    view.dispatch({
      changes: {
        from: line.to,
        insert: padCells(view.state.doc.sliceString(line.from, line.to), missing),
      },
      userEvent: "input",
    });
  }
  // The dispatch above re-rendered the widget, so host.model is current again.
  const cell = host.model.rows[row]?.[col];
  const table = host.model.lines[0]?.from;
  if (!cell || table === undefined) return;
  view.dispatch({
    effects: setCellEdit.of({
      table,
      row,
      col,
      caret: Math.min(caret ?? cell.text.length, cell.text.length),
    }),
  });
}

/** Add an empty row at the end of the table and move the edit into it. */
function appendRow(host: CellHost, col: number): void {
  const { view, model } = host;
  const last = model.lines[model.lines.length - 1];
  const table = model.lines[0]?.from;
  if (!last || table === undefined) return;
  view.dispatch({
    changes: { from: last.to, insert: `\n|${"  |".repeat(model.cols)}` },
    effects: setCellEdit.of({ table, row: model.lines.length, col, caret: 0 }),
    userEvent: "input",
  });
}

/** End the edit and hand focus back to the editor, just outside the table. */
function leaveTable(host: CellHost): void {
  const { view, model } = host;
  const doc = view.state.doc;
  if (!model.lines.length) return;
  const first = doc.lineAt(model.lines[0].from);
  const last = doc.lineAt(model.lines[model.lines.length - 1].from);
  const anchor =
    last.number < doc.lines
      ? doc.line(last.number + 1).from
      : first.number > 1
        ? doc.line(first.number - 1).to
        : first.from; // nothing outside the table: fall back to its source
  view.dispatch({ selection: { anchor }, effects: setCellEdit.of(null) });
  view.focus();
}

/** Explicitly reveal the table markdown at the cell currently being edited. */
function revealSource(host: CellHost): void {
  const { view, model, edit } = host;
  const cell = edit ? model.rows[edit.row]?.[edit.col] : null;
  const first = model.lines[0];
  const last = model.lines[model.lines.length - 1];
  if (!first || !last) return;
  const anchor = cell
    ? cell.from + Math.min(edit?.caret ?? 0, cell.text.length)
    : first.from;
  view.dispatch({
    selection: { anchor },
    effects: [
      setCellEdit.of(null),
      setSourceTable.of({ from: first.from, to: last.to }),
    ],
  });
  view.focus();
}

/** Drop an edit whose cell no longer exists (an undo, an external change). */
function scheduleClear(host: CellHost, at: CellEdit): void {
  setTimeout(() => {
    const now = host.edit;
    if (now && now.table === at.table && now.row === at.row && now.col === at.col)
      host.view.dispatch({ effects: setCellEdit.of(null) });
  }, 0);
}

/** Write the textarea back into its cell's source range. */
function commitInput(host: CellHost): void {
  const { view, input, edit } = host;
  if (!input || !edit) return;
  const cell = host.model.rows[edit.row]?.[edit.col];
  if (!cell) return;
  const clean = sanitizeCellInput(input.value, input.selectionStart);
  if (clean.text !== input.value) {
    input.value = clean.text;
    setCaret(input, clean.caret);
  }
  if (clean.text === cell.text) return;
  view.dispatch({
    changes: { from: cell.from, to: cell.to, insert: clean.text },
    effects: setCellEdit.of({ ...edit, caret: clean.caret }),
    userEvent: "input.type",
  });
}

/** Run an editor history command without kicking the user out of the cell. */
function runHistory(host: CellHost, command: (view: EditorView) => boolean): void {
  const at = host.edit;
  if (!command(host.view) || !at) return;
  // History transactions carry a selection, which ends the in-place edit.
  host.view.dispatch({ effects: setCellEdit.of(at) });
}

function onInputKey(host: CellHost, event: KeyboardEvent): void {
  const { input, edit, model } = host;
  if (!input || !edit) return;
  if (event.isComposing || event.keyCode === 229) return;
  const key = event.key;

  if ((event.metaKey || event.ctrlKey) && (key === "z" || key === "Z")) {
    // The textarea's own undo stack knows nothing about the document, so run
    // the editor's history instead.
    event.preventDefault();
    runHistory(host, event.shiftKey ? redo : undo);
    return;
  }
  if ((event.metaKey || event.ctrlKey) && (key === "y" || key === "Y")) {
    event.preventDefault();
    runHistory(host, redo);
    return;
  }
  // Everything else with a modifier belongs to the app (⌘S) or to the
  // textarea's native editing (⌘A, ⌥←).
  if (event.metaKey || event.ctrlKey || event.altKey) return;

  if (key === "Tab") {
    event.preventDefault();
    const next = stepCell(model, edit.row, edit.col, event.shiftKey ? -1 : 1);
    if (next) startEdit(host, next.row, next.col, null);
    else if (!event.shiftKey) appendRow(host, 0);
    return;
  }
  if (key === "Enter") {
    event.preventDefault();
    const row = stepRow(model, edit.row, 1);
    if (row === null) appendRow(host, edit.col);
    else startEdit(host, row, edit.col, null);
    return;
  }
  if (key === "Escape") {
    event.preventDefault();
    leaveTable(host);
    return;
  }
  // Cells are always single-line (sanitizeCellInput flattens pastes), so up and
  // down can move between rows the way they would in a spreadsheet.
  if (key === "ArrowUp" || key === "ArrowDown") {
    const row = stepRow(model, edit.row, key === "ArrowUp" ? -1 : 1);
    if (row === null) return;
    event.preventDefault();
    startEdit(host, row, edit.col, input.selectionStart);
    return;
  }
  if (key === "ArrowLeft" && atStart(input)) {
    const prev = stepCell(model, edit.row, edit.col, -1);
    if (!prev) return;
    event.preventDefault();
    startEdit(host, prev.row, prev.col, null);
    return;
  }
  if (key === "ArrowRight" && atEnd(input)) {
    const next = stepCell(model, edit.row, edit.col, 1);
    if (!next) return;
    event.preventDefault();
    startEdit(host, next.row, next.col, 0);
  }
}

function onInputBlur(host: CellHost): void {
  const at = host.edit;
  const input = host.input;
  if (!at || !input) return;
  // A blur also fires when the widget is torn down under an active edit, or
  // when another cell takes over; only a real focus loss ends editing.
  setTimeout(() => {
    if (!input.isConnected || host.view.root.activeElement === input) return;
    const now = host.edit;
    if (!now || now.row !== at.row || now.col !== at.col) return;
    host.view.dispatch({ effects: setCellEdit.of(null) });
  }, 0);
}

function createInput(host: CellHost): HTMLTextAreaElement {
  const input = document.createElement("textarea");
  input.className = "cm-md-cell-input";
  input.rows = 1;
  input.spellcheck = false;
  input.setAttribute("aria-label", "编辑表格单元格");
  // The overlay covers its cell, so these would otherwise re-enter the cell
  // click handler underneath.
  input.addEventListener("mousedown", (e) => e.stopPropagation());
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("compositionstart", () => {
    host.composing = true;
  });
  input.addEventListener("compositionend", () => {
    host.composing = false;
    commitInput(host);
  });
  input.addEventListener("input", () => {
    // Mid-composition the document has to lag: writing back would rebuild the
    // widget and cancel the IME session.
    if (!host.composing) commitInput(host);
  });
  input.addEventListener("keydown", (e) => onInputKey(host, e));
  input.addEventListener("blur", () => onInputBlur(host));
  host.wrap.appendChild(input);
  host.input = input;
  return input;
}

const edge = (border: string, padding: string): string =>
  `${(parseFloat(border) || 0) + (parseFloat(padding) || 0)}px`;

/** Park the textarea exactly on top of its cell's text box. */
function layoutInput(host: CellHost): void {
  const { input, edit } = host;
  if (!input || !edit) return;
  if (!host.block.isConnected) {
    // toDOM builds the widget before it is inserted, where every box is 0x0.
    requestAnimationFrame(() => {
      if (host.block.isConnected) layoutInput(host);
    });
    return;
  }
  const cell = cellElement(host.table, edit.row, edit.col);
  if (!cell) return;
  const style = getComputedStyle(cell);
  const s = input.style;
  // Rects rather than offsetLeft/Top: those round to whole pixels, which is
  // enough to shift the caret off the text drawn behind it.
  const box = cell.getBoundingClientRect();
  const origin = host.wrap.getBoundingClientRect();
  s.left = `${box.left - origin.left + host.wrap.scrollLeft}px`;
  s.top = `${box.top - origin.top + host.wrap.scrollTop}px`;
  s.width = `${box.width}px`;
  s.height = `${box.height}px`;
  // Match the cell's own text box so the caret sits exactly where the
  // (transparent) source text behind it is drawn.
  s.padding = [
    edge(style.borderTopWidth, style.paddingTop),
    edge(style.borderRightWidth, style.paddingRight),
    edge(style.borderBottomWidth, style.paddingBottom),
    edge(style.borderLeftWidth, style.paddingLeft),
  ].join(" ");
  s.fontFamily = style.fontFamily;
  s.fontSize = style.fontSize;
  s.fontWeight = style.fontWeight;
  s.fontStyle = style.fontStyle;
  s.lineHeight = style.lineHeight;
  s.letterSpacing = style.letterSpacing;
  s.textAlign = style.textAlign;
  s.whiteSpace = style.whiteSpace === "nowrap" ? "pre" : "pre-wrap";
}

/** Create, move or drop the cell editor to match the current edit state. */
function syncInput(host: CellHost): void {
  const edit = host.edit;
  if (!edit) {
    host.input?.remove();
    host.input = null;
    return;
  }
  const cell = host.model.rows[edit.row]?.[edit.col];
  if (!cell) {
    // The cell went away under us (undo, external change); let the state catch
    // up outside this render.
    host.input?.remove();
    host.input = null;
    scheduleClear(host, edit);
    return;
  }
  const fresh = !host.input;
  const input = host.input ?? createInput(host);
  const moved =
    input.dataset.row !== String(edit.row) ||
    input.dataset.col !== String(edit.col);
  input.dataset.row = String(edit.row);
  input.dataset.col = String(edit.col);
  const caret = Math.min(edit.caret, cell.text.length);
  // While composing, the textarea is ahead of the document on purpose.
  if (!host.composing && input.value !== cell.text) {
    input.value = cell.text;
    setCaret(input, caret);
  }
  // Take focus only for a newly built element (the widget DOM was rebuilt under
  // an active edit) or a move to another cell — never on a plain re-render,
  // which would steal focus back from wherever the user just went.
  if (fresh || moved) {
    const place = () => {
      if (!input.isConnected) return;
      input.focus({ preventScroll: true });
      setCaret(input, caret);
    };
    if (input.isConnected) place();
    else requestAnimationFrame(place);
  }
  layoutInput(host);
}

// ---------------------------------------------------------------------------
// Widget DOM
// ---------------------------------------------------------------------------

/** Lucide Code2 glyph, matching EditorModeTabs' source-mode button. */
const SOURCE_ICON =
  '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m18 16 4-4-4-4" /><path d="m6 8-4 4 4 4" /><path d="m14.5 4-5 16" /></svg>';

function createSourceButton(host: CellHost): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "cm-md-table-source";
  button.title = "显示表格源码";
  button.setAttribute("aria-label", "显示表格源码");
  button.innerHTML = SOURCE_ICON;
  for (const type of ["pointerdown", "mousedown", "touchstart"] as const)
    button.addEventListener(type, (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    revealSource(host);
  });
  return button;
}

function onCellClick(host: CellHost, event: MouseEvent): void {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey)
    return;
  // A press that travelled is a text selection, not a request to edit.
  const press = host.press;
  host.press = null;
  if (
    press &&
    Math.max(
      Math.abs(event.clientX - press.x),
      Math.abs(event.clientY - press.y),
    ) > 3
  )
    return;
  const cell = (event.target as HTMLElement).closest?.("th,td");
  if (!(cell instanceof HTMLTableCellElement) || !host.table.contains(cell))
    return;
  const row = Number(cell.dataset.row);
  const col = Number(cell.dataset.col);
  if (!Number.isInteger(row) || !Number.isInteger(col)) return;
  const text = host.model.rows[row]?.[col]?.text ?? "";
  startEdit(host, row, col, caretFromPoint(cell, text, event));
}

/** The two spellings of "which character is at this point" browsers ship. */
type CaretRange = { startContainer: Node; startOffset: number };
type CaretSource = {
  caretPositionFromPoint?: (
    x: number,
    y: number,
  ) => { offsetNode: Node; offset: number } | null;
  caretRangeFromPoint?: (x: number, y: number) => CaretRange | null;
};

/**
 * Where to drop the caret inside the cell's source. Only cells whose markdown
 * renders to itself (plain text — the common case) can map a click position;
 * anything with inline markup falls back to the end of the text.
 */
function caretFromPoint(
  cell: HTMLElement,
  text: string,
  event: MouseEvent,
): number | null {
  if ((cell.textContent ?? "") !== text) return null;
  const doc: CaretSource = cell.ownerDocument;
  let node: Node | null = null;
  let offset = 0;
  if (doc.caretPositionFromPoint) {
    const pos = doc.caretPositionFromPoint(event.clientX, event.clientY);
    if (pos) {
      node = pos.offsetNode;
      offset = pos.offset;
    }
  } else if (doc.caretRangeFromPoint) {
    const range = doc.caretRangeFromPoint(event.clientX, event.clientY);
    if (range) {
      node = range.startContainer;
      offset = range.startOffset;
    }
  }
  if (!node || node.nodeType !== Node.TEXT_NODE || !cell.contains(node))
    return null;
  // Sum the text before the clicked node so the offset is cell-relative.
  let total = 0;
  const walker = cell.ownerDocument.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n === node) return Math.min(total + offset, text.length);
    total += n.nodeValue?.length ?? 0;
  }
  return null;
}

function createHost(view: EditorView, readOnly: boolean): CellHost {
  const block = document.createElement("div");
  block.className = "cm-md-table-block";
  const wrap = document.createElement("div");
  wrap.className = "cm-md-table-wrap";
  const table = document.createElement("table");
  table.className = "cm-md-table";
  wrap.appendChild(table);
  block.appendChild(wrap);

  const host: CellHost = {
    view,
    block,
    wrap,
    table,
    model: EMPTY_MODEL,
    edit: null,
    input: null,
    composing: false,
    press: null,
    resize: null,
  };
  hosts.set(block, host);

  // Cmd/Ctrl+click on a link inside a cell. Handled here because widget DOM
  // events never reach the editor-level handler in linkClick.ts.
  wrap.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || !(e.metaKey || e.ctrlKey)) return;
    const href = (e.target as HTMLElement)
      .closest?.("[data-href]")
      ?.getAttribute("data-href");
    if (!href) return;
    e.preventDefault();
    e.stopPropagation();
    openLinkTargetSafe(href);
  });

  if (!readOnly) {
    table.addEventListener("mousedown", (e) => {
      host.press = { x: e.clientX, y: e.clientY };
    });
    table.addEventListener("click", (e) => onCellClick(host, e));
    block.appendChild(createSourceButton(host));
    // The overlay is placed from its cell's box, so follow every reflow of the
    // table (window resize, sidebar toggle, font change).
    host.resize = new ResizeObserver(() => layoutInput(host));
    host.resize.observe(table);
  }
  return host;
}

/** Whether the existing DOM still has the shape the model needs. */
function canReuse(table: HTMLTableElement, model: TableModel): boolean {
  const head = table.tHead?.rows[0];
  const body = table.tBodies[0];
  if (!head || !body) return false;
  if (head.cells.length !== model.cols) return false;
  if (body.rows.length !== Math.max(0, model.rows.length - DELIM_ROW - 1))
    return false;
  for (const row of body.rows) if (row.cells.length !== model.cols) return false;
  return true;
}

function buildSkeleton(table: HTMLTableElement, model: TableModel): void {
  table.textContent = "";
  if (!model.rows.length) return;
  const addRow = (parent: HTMLElement, row: number, tag: "th" | "td") => {
    const tr = document.createElement("tr");
    for (let col = 0; col < model.cols; col++) {
      const el = document.createElement(tag);
      el.dataset.row = String(row);
      el.dataset.col = String(col);
      tr.appendChild(el);
    }
    parent.appendChild(tr);
  };
  const thead = document.createElement("thead");
  addRow(thead, 0, "th");
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  for (let row = DELIM_ROW + 1; row < model.rows.length; row++)
    addRow(tbody, row, "td");
  table.appendChild(tbody);
}

function render(
  host: CellHost,
  model: TableModel,
  edit: CellEdit | null,
): void {
  host.model = model;
  host.edit = edit;
  const reuse = canReuse(host.table, model);
  if (!reuse) buildSkeleton(host.table, model);
  const wraps = wrapColumns(model);
  for (let row = 0; row < model.rows.length; row++) {
    if (row === DELIM_ROW) continue;
    for (let col = 0; col < model.cols; col++) {
      const el = cellElement(host.table, row, col);
      if (!el) continue;
      const text = model.rows[row][col]?.text ?? "";
      const editing = !!edit && edit.row === row && edit.col === col;
      const wasEditing = el.classList.contains("cm-md-cell-editing");
      // data-text records what the cell was last rendered from, so a keystroke
      // only re-renders the one cell that changed.
      if (!reuse || el.dataset.text !== text || editing !== wasEditing) {
        el.classList.toggle("cm-md-cell-editing", editing);
        // The edited cell shows its raw source, painted transparent: it is what
        // keeps the column sized to the text the textarea on top is showing.
        if (editing) el.textContent = text || " ";
        else renderCell(text, el);
        el.dataset.text = text;
      }
      el.style.textAlign = model.align[col] || "";
      el.classList.toggle("cm-md-cell-wrap", wraps[col]);
    }
  }
  syncInput(host);
}

class TableWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly from: number,
    readonly readOnly: boolean,
    readonly edit: CellEdit | null,
  ) {
    super();
  }
  eq(o: TableWidget) {
    return (
      o.source === this.source &&
      o.from === this.from &&
      o.readOnly === this.readOnly &&
      o.edit?.row === this.edit?.row &&
      o.edit?.col === this.edit?.col
    );
  }
  toDOM(view: EditorView) {
    const host = createHost(view, this.readOnly);
    render(host, parseTable(this.source, this.from), this.edit);
    return host.block;
  }
  // Reuse the DOM instead of rebuilding it: the cell editor lives in there and
  // would lose focus (and its caret) on every keystroke otherwise.
  updateDOM(dom: HTMLElement, _view: EditorView, prev: TableWidget) {
    const host = hosts.get(dom);
    if (!host || prev.readOnly !== this.readOnly) return false;
    render(host, parseTable(this.source, this.from), this.edit);
    return true;
  }
  destroy(dom: HTMLElement) {
    hosts.get(dom)?.resize?.disconnect();
  }
  // The widget runs its own mouse and keyboard handling (cell editing, the
  // source button, selecting rendered text), so the editor has to stay out of
  // events fired inside it — including the DOM selection changes they cause.
  ignoreEvent() {
    return true;
  }
}

function buildTables(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const active = state.field(cellEditField, false) ?? null;
  const sourceTable = state.field(sourceTableField, false) ?? null;
  // Force parsing forward so tables below the lazily-parsed region render right
  // away on open, not only after the first interaction.
  const tree =
    ensureSyntaxTree(state, state.doc.length, 50) ?? syntaxTree(state);
  tree.iterate({
    enter: (node) => {
      if (node.name !== "Table") return;
      // Snap to whole lines (block replacements must cover full lines).
      const from = state.doc.lineAt(node.from).from;
      const to = state.doc.lineAt(node.to).to;
      const edit =
        active && !state.readOnly && active.table === from ? active : null;
      // Only the source button may un-render a table. Selection changes inside
      // the widget are intentionally ignored, including repeated pointer clicks
      // and keyboard/search selections that happen to land in its document
      // range. Read-only mode always renders the table.
      const explicitlyRevealed =
        !state.readOnly &&
        sourceTable?.from === from &&
        sourceTable.to === to;
      if (explicitlyRevealed) return false;
      const source = state.doc.sliceString(from, to);
      ranges.push(
        Decoration.replace({
          widget: new TableWidget(source, from, state.readOnly, edit),
          block: true,
        }).range(from, to),
      );
      return false;
    },
  });
  return Decoration.set(ranges, true);
}

const tableDecorations = StateField.define<DecorationSet>({
  create: (state) => buildTables(state),
  update(deco, tr) {
    if (
      tr.docChanged ||
      tr.selection ||
      tr.startState.readOnly !== tr.state.readOnly ||
      tr.effects.some(
        (e) =>
          e.is(parseAdvanced) || e.is(setCellEdit) || e.is(setSourceTable),
      )
    )
      return buildTables(tr.state);
    return deco.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

// State fields come first: tableDecorations reads both while updating.
export const tablePreview: Extension = [
  cellEditField,
  sourceTableField,
  tableDecorations,
];
