// Raw-HTML live preview for CodeMirror 6.
//
// Markdown may embed HTML — block-level (`<div>…</div>`, `<details>`, a raw
// `<table>`) or inline (`<font color>`, `<u>`, `<br>` inside a paragraph). Like
// tables, rendering it means replacing whole lines with a block widget, which
// must come from a StateField (a ViewPlugin may not emit block decorations) —
// so this lives alongside tablePreview rather than in livePreview. When the
// selection is inside the rendered region we leave the source visible so it
// stays editable. All HTML is sanitized before it reaches the DOM.

import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorState, StateField, Range } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";

import { parseAdvanced } from "./livePreview";
import { renderInlineHtml, sanitizeHtml, hasInlineHtml } from "./inlineHtml";
import { toDisplaySrc } from "../imagePath";

class HtmlWidget extends WidgetType {
  constructor(
    readonly html: string, // already sanitized
    readonly from: number,
    // Inline tags inside a list item / blockquote render as a <span> so the
    // line (bullet, indent) is preserved; block HTML and top-level paragraphs
    // render as a <div>.
    readonly inline = false,
  ) {
    super();
  }
  eq(o: HtmlWidget) {
    return o.html === this.html && o.from === this.from && o.inline === this.inline;
  }
  toDOM(view: EditorView) {
    const el = document.createElement(this.inline ? "span" : "div");
    el.className = this.inline ? "cm-md-html-inline" : "cm-md-html";
    el.innerHTML = this.html;
    el.querySelectorAll("img").forEach((img) => {
      // innerHTML keeps the src verbatim; rewrite local paths to the asset
      // protocol (remote URLs pass through) so <img> matches Markdown images.
      const raw = img.getAttribute("src");
      if (raw) img.src = toDisplaySrc(raw);
      const requestMeasure = () => view.requestMeasure();
      img.addEventListener("load", requestMeasure);
      img.addEventListener("error", requestMeasure);
      if (img.complete) queueMicrotask(requestMeasure);
    });
    // Click to edit: drop the caret into the source so it reveals.
    el.addEventListener("mousedown", (e) => {
      // Let links/checkboxes inside the rendered HTML behave normally.
      if ((e.target as HTMLElement).closest("a")) return;
      e.preventDefault();
      view.dispatch({ selection: { anchor: this.from } });
      view.focus();
    });
    return el;
  }
  ignoreEvent() {
    return false;
  }
}

function buildHtml(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const tree =
    ensureSyntaxTree(state, state.doc.length, 50) ?? syntaxTree(state);

  const add = (nodeFrom: number, nodeTo: number, html: string) => {
    // Snap to whole lines (block replacements must cover full lines).
    const from = state.doc.lineAt(nodeFrom).from;
    const to = state.doc.lineAt(nodeTo).to;
    // Keep the source visible while the cursor is inside the region — except in
    // read-only mode, where it always stays rendered.
    const inside =
      !state.readOnly &&
      state.selection.ranges.some((r) => r.from <= to && r.to >= from);
    if (inside) return;
    ranges.push(
      Decoration.replace({
        widget: new HtmlWidget(html, from),
        block: true,
      }).range(from, to),
    );
  };

  tree.iterate({
    enter: (node) => {
      if (node.name === "HTMLBlock") {
        // Block HTML is raw — no markdown processing inside it.
        const src = state.doc.sliceString(node.from, node.to);
        add(node.from, node.to, sanitizeHtml(src));
        return false;
      }
      if (node.name === "Paragraph") {
        const src = state.doc.sliceString(node.from, node.to);
        if (!hasInlineHtml(src)) return false;
        if (node.node.parent?.name === "Document") {
          // Top-level paragraph: replace the whole block.
          add(node.from, node.to, sanitizeHtml(renderInlineHtml(src)));
        } else {
          // Inside a list item / blockquote: keep the line (bullet, indent) by
          // replacing only the inline text. An inline decoration can't cross
          // line breaks, so multi-line paragraphs here stay as source.
          const lineFrom = state.doc.lineAt(node.from);
          if (state.doc.lineAt(node.to).number !== lineFrom.number) return false;
          const active =
            !state.readOnly &&
            state.selection.ranges.some((r) => {
              const a = state.doc.lineAt(r.from).number;
              const b = state.doc.lineAt(r.to).number;
              return lineFrom.number >= a && lineFrom.number <= b;
            });
          if (!active)
            ranges.push(
              Decoration.replace({
                widget: new HtmlWidget(
                  sanitizeHtml(renderInlineHtml(src)),
                  node.from,
                  true,
                ),
              }).range(node.from, node.to),
            );
        }
        return false;
      }
      return undefined;
    },
  });

  return Decoration.set(ranges, true);
}

export const htmlPreview = StateField.define<DecorationSet>({
  create: (state) => buildHtml(state),
  update(deco, tr) {
    if (
      tr.docChanged ||
      tr.selection ||
      tr.startState.readOnly !== tr.state.readOnly ||
      tr.effects.some((e) => e.is(parseAdvanced))
    )
      return buildHtml(tr.state);
    return deco.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});
