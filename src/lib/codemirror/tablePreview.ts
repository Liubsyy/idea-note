// GFM table live preview for CodeMirror 6.
//
// A markdown table spans several lines, so rendering it as a real <table>
// means replacing those lines with a block widget. Block decorations that
// cover line breaks must come from a StateField (a ViewPlugin may not), which
// is why this lives apart from livePreview.ts. When the selection is inside the
// table we leave the raw source visible so it stays editable.

import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorState, StateField, Range } from "@codemirror/state";
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

/**
 * Split a "| a | b |" row into trimmed cell strings. Per GFM, a `\|` is a
 * literal pipe inside the cell, not a separator; the backslash stays in the
 * cell text so renderInlineHtml's escape handling (`\x` -> `x`) unwraps it.
 */
function parseRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  const cells: string[] = [];
  let cur = "";
  let closed = false; // row ended right after an unescaped `|`
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length) {
      cur += c + s[i + 1];
      i++;
      closed = false;
    } else if (c === "|") {
      cells.push(cur.trim());
      cur = "";
      closed = true;
    } else {
      cur += c;
      closed = false;
    }
  }
  if (!closed) cells.push(cur.trim());
  return cells;
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
    n += /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-鿿가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(
      ch,
    )
      ? 2
      : 1;
  }
  return n;
}

/** Read column alignment from the delimiter row (e.g. `:---`, `:--:`, `--:`). */
function parseAlign(delim: string): Align[] {
  return parseRow(delim).map((c) => {
    const l = c.startsWith(":");
    const r = c.endsWith(":");
    if (l && r) return "center";
    if (r) return "right";
    if (l) return "left";
    return "";
  });
}

class TableWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly from: number,
    readonly readOnly: boolean,
  ) {
    super();
  }
  eq(o: TableWidget) {
    return (
      o.source === this.source &&
      o.from === this.from &&
      o.readOnly === this.readOnly
    );
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "cm-md-table-wrap";
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

    const lines = this.source.split("\n").filter((l) => l.trim() !== "");
    const table = document.createElement("table");
    table.className = "cm-md-table";

    if (lines.length) {
      const header = parseRow(lines[0]);
      const align = lines.length > 1 ? parseAlign(lines[1]) : [];
      const body: string[][] = [];
      for (let i = 2; i < lines.length; i++) body.push(parseRow(lines[i]));

      // Decide which columns may wrap: only the wide ones. Their widest cell
      // sets the column width, so the long column gives up space and wraps while
      // narrow (label/number) columns stay on a single line. Tagged via the
      // cm-md-cell-wrap class; the rest default to nowrap (see editor.css).
      const wrap = header.map((h, j) => {
        let w = visualLen(h);
        for (const row of body) w = Math.max(w, visualLen(row[j] ?? ""));
        return w > WRAP_THRESHOLD;
      });

      const thead = document.createElement("thead");
      const htr = document.createElement("tr");
      header.forEach((c, j) => {
        const th = document.createElement("th");
        renderCell(c, th);
        if (align[j]) th.style.textAlign = align[j];
        if (wrap[j]) th.classList.add("cm-md-cell-wrap");
        htr.appendChild(th);
      });
      thead.appendChild(htr);
      table.appendChild(thead);

      const tbody = document.createElement("tbody");
      for (const cells of body) {
        const tr = document.createElement("tr");
        for (let j = 0; j < header.length; j++) {
          const td = document.createElement("td");
          renderCell(cells[j] ?? "", td);
          if (align[j]) td.style.textAlign = align[j];
          if (wrap[j]) td.classList.add("cm-md-cell-wrap");
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
    }

    // Click to edit: drop the caret into the table source so it reveals. Not in
    // read-only mode — there the table stays rendered, and preventing the
    // default mousedown would block the user from selecting the cell text.
    if (!this.readOnly) {
      wrap.addEventListener("mousedown", (e) => {
        e.preventDefault();
        view.dispatch({ selection: { anchor: this.from } });
        view.focus();
      });
    }
    wrap.appendChild(table);
    return wrap;
  }
  // Editable: CM handles events (drives click-to-edit). Read-only: ignore them
  // so the browser handles the mouse natively and the cell text is selectable.
  ignoreEvent() {
    return this.readOnly;
  }
}

function buildTables(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = [];
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
      // Keep the source visible while the cursor is inside the table — but not
      // in read-only mode, where nothing is editable so the table always stays
      // rendered even when selected.
      const inside =
        !state.readOnly &&
        state.selection.ranges.some((r) => r.from <= to && r.to >= from);
      if (inside) return false;
      const source = state.doc.sliceString(from, to);
      ranges.push(
        Decoration.replace({
          widget: new TableWidget(source, from, state.readOnly),
          block: true,
        }).range(from, to),
      );
      return false;
    },
  });
  return Decoration.set(ranges, true);
}

export const tablePreview = StateField.define<DecorationSet>({
  create: (state) => buildTables(state),
  update(deco, tr) {
    if (
      tr.docChanged ||
      tr.selection ||
      tr.startState.readOnly !== tr.state.readOnly ||
      tr.effects.some((e) => e.is(parseAdvanced))
    )
      return buildTables(tr.state);
    return deco.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});
