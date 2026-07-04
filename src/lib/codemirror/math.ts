// KaTeX-backed math rendering for the live preview.
//
// Two pieces:
//   1. `inlineMath` — a @lezer/markdown extension that parses `$...$` into an
//      InlineMath node so livePreview.ts can replace it with a rendered widget.
//   2. `mathBlock` — a StateField that renders fenced `$$ ... $$` blocks as a
//      display-mode widget. Block widgets that span line breaks must come from a
//      StateField (a ViewPlugin may not), same constraint as tablePreview.ts.

import katex from "katex";
import "katex/dist/katex.min.css";

import { MarkdownConfig } from "@lezer/markdown";
import { EditorState, Range, StateField } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";

const DOLLAR = 36; // '$'

const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === -1;
const isDigit = (c: number) => c >= 48 && c <= 57;

/** Renders TeX into `el`, falling back to the raw source on a parse error. */
function renderInto(el: HTMLElement, tex: string, display: boolean) {
  try {
    katex.render(tex, el, { displayMode: display, throwOnError: false });
  } catch {
    el.classList.add("cm-md-math-error");
    el.textContent = tex;
  }
}

export class MathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly block: boolean,
    readonly from = -1,
  ) {
    super();
  }
  eq(o: MathWidget) {
    return o.tex === this.tex && o.block === this.block;
  }
  toDOM(view: EditorView) {
    const el = document.createElement(this.block ? "div" : "span");
    el.className = this.block ? "cm-md-math-block" : "cm-md-math-inline";
    renderInto(el, this.tex, this.block);
    if (this.block) {
      // Click to edit: drop the caret into the source so the block reveals.
      el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        view.dispatch({ selection: { anchor: this.from } });
        view.focus();
      });
    }
    return el;
  }
  ignoreEvent() {
    return false;
  }
}

// --- Inline `$...$` ---------------------------------------------------------

const InlineMathDelim = { resolve: "InlineMath", mark: "InlineMathMark" };

export const inlineMath: MarkdownConfig = {
  defineNodes: [{ name: "InlineMath" }, { name: "InlineMathMark" }],
  parseInline: [
    {
      name: "InlineMath",
      parse(cx, next, pos) {
        if (next !== DOLLAR) return -1;
        // Leave `$$` to the block-level renderer.
        if (cx.char(pos + 1) === DOLLAR) return -1;
        const before = cx.char(pos - 1);
        const after = cx.char(pos + 1);
        // A `$` can open only if not followed by whitespace, and can close only
        // if not preceded by whitespace and not followed by a digit — this keeps
        // prose like "it cost $5 and $6" from being treated as math.
        const canOpen = !isSpace(after);
        const canClose = !isSpace(before) && !isDigit(after);
        if (!canOpen && !canClose) return -1;
        return cx.addDelimiter(InlineMathDelim, pos, pos + 1, canOpen, canClose);
      },
    },
  ],
};

// --- Block `$$ ... $$` ------------------------------------------------------

const FENCE = /^\s*(`{3,}|~{3,})/;
const SINGLE_LINE = /^\$\$(.+?)\$\$$/;

function buildMath(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const doc = state.doc;
  let inFence = false;
  let i = 1;
  while (i <= doc.lines) {
    const line = doc.line(i);
    const trimmed = line.text.trim();

    // Track code fences so `$$` inside a code block isn't treated as math.
    if (FENCE.test(line.text)) {
      inFence = !inFence;
      i++;
      continue;
    }
    if (inFence) {
      i++;
      continue;
    }

    // Read-only mode never edits, so keep math rendered even when selected.
    const touches = (from: number, to: number) =>
      !state.readOnly &&
      state.selection.ranges.some((r) => r.from <= to && r.to >= from);

    // Single-line `$$ ... $$`.
    const single = trimmed.match(SINGLE_LINE);
    if (single) {
      if (!touches(line.from, line.to))
        ranges.push(
          Decoration.replace({
            widget: new MathWidget(single[1].trim(), true, line.from),
            block: true,
          }).range(line.from, line.to),
        );
      i++;
      continue;
    }

    // Fenced block: a line that is exactly `$$` opens it, the next `$$` closes.
    if (trimmed === "$$") {
      let j = i + 1;
      while (j <= doc.lines && doc.line(j).text.trim() !== "$$") j++;
      if (j <= doc.lines) {
        const from = line.from;
        const to = doc.line(j).to;
        if (!touches(from, to)) {
          const tex =
            j > i + 1
              ? doc.sliceString(doc.line(i + 1).from, doc.line(j - 1).to).trim()
              : "";
          ranges.push(
            Decoration.replace({
              widget: new MathWidget(tex, true, from),
              block: true,
            }).range(from, to),
          );
        }
        i = j + 1;
        continue;
      }
    }
    i++;
  }
  return Decoration.set(ranges, true);
}

export const mathBlock = StateField.define<DecorationSet>({
  create: (state) => buildMath(state),
  update(deco, tr) {
    if (
      tr.docChanged ||
      tr.selection ||
      tr.startState.readOnly !== tr.state.readOnly
    )
      return buildMath(tr.state);
    return deco.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});
