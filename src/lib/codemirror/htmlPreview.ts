// Raw-HTML live preview for CodeMirror 6.
//
// Markdown may embed HTML — block-level (`<div>…</div>`, `<details>`, a raw
// `<table>`) or inline (`<span style>`, `<font color>`, `<u>` inside a
// paragraph). Like tables, a block-level one is rendered by replacing whole
// lines with a block widget, which must come from a StateField (a ViewPlugin
// may not emit block decorations) — so this lives alongside tablePreview rather
// than in livePreview.
//
// Inline HTML is decorated one region at a time (see inlineRegions) instead of
// a paragraph at a time: a line is usually mostly markdown with a `<span>` or
// two in it, and replacing the whole paragraph would mean the cursor landing
// anywhere on that line reverts all of it to source. Only the region the
// selection touches shows its source, so it stays editable while the rest of
// the line keeps rendering. All HTML is sanitized before it reaches the DOM.

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

// One HTML tag, comment or entity. Kept to simple alternatives — no lookbehind,
// no named groups — for the macOS 12 WKWebView.
const HTML_TOKEN =
  /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s[^<>]*)?)(\/?)>|<!--[\s\S]*?-->|&(?:[a-zA-Z][a-zA-Z0-9]*|#\d+|#[xX][0-9a-fA-F]+);/g;

// Tags that never have a closing partner, so they stand alone as a region.
const VOID_TAGS = new Set([
  "area", "base", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

/**
 * The self-contained inline HTML in one line of markdown: each balanced tag
 * pair (`<span …>…</span>`, outermost only), void tag, comment or entity.
 * Offsets are absolute, `base` being the offset of `text` in the document.
 *
 * Unbalanced markup yields no region and simply stays as source. `<br>` is left
 * out: livePreview already renders it, and two widgets over one range conflict.
 */
function inlineRegions(
  text: string,
  base: number,
): { from: number; to: number }[] {
  const regions: { from: number; to: number }[] = [];
  let depth = 0;
  let start = 0;
  let openTag = "";
  HTML_TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HTML_TOKEN.exec(text))) {
    const from = base + m.index;
    const to = from + m[0].length;
    const name = m[2]?.toLowerCase();
    // A comment or an entity: a whole region on its own when not already inside
    // one, otherwise just part of the enclosing tag's content.
    if (!name) {
      if (depth === 0) regions.push({ from, to });
      continue;
    }
    const closing = m[1] === "/";
    const standalone = m[4] === "/" || VOID_TAGS.has(name);
    if (depth === 0) {
      if (closing) continue; // a stray `</b>` — nothing to pair it with
      if (standalone) regions.push({ from, to });
      else {
        depth = 1;
        start = from;
        openTag = name;
      }
      continue;
    }
    // Inside a pair: only the same tag name nests or closes it.
    if (standalone || name !== openTag) continue;
    if (!closing) depth += 1;
    else if (--depth === 0) regions.push({ from: start, to });
  }
  return regions;
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

  /**
   * Render each inline HTML region in [nodeFrom, nodeTo] on its own, one line at
   * a time. Only the region the selection touches falls back to source, so
   * putting the cursor elsewhere on the line leaves the rest rendered — and
   * everything outside the regions (markdown, list bullets, heading size) is
   * left to livePreview, untouched.
   */
  const addRegions = (nodeFrom: number, nodeTo: number) => {
    const last = state.doc.lineAt(nodeTo).number;
    for (let n = state.doc.lineAt(nodeFrom).number; n <= last; n++) {
      const line = state.doc.line(n);
      const from = Math.max(line.from, nodeFrom);
      const to = Math.min(line.to, nodeTo);
      if (from >= to) continue;
      for (const region of inlineRegions(state.doc.sliceString(from, to), from)) {
        const active =
          !state.readOnly &&
          state.selection.ranges.some(
            (r) => r.from <= region.to && r.to >= region.from,
          );
        if (active) continue;
        ranges.push(
          Decoration.replace({
            widget: new HtmlWidget(
              sanitizeHtml(
                renderInlineHtml(state.doc.sliceString(region.from, region.to)),
              ),
              region.from,
              true,
            ),
          }).range(region.from, region.to),
        );
      }
    }
  };

  tree.iterate({
    enter: (node) => {
      if (node.name === "HTMLBlock") {
        // Block HTML is raw — no markdown processing inside it.
        const src = state.doc.sliceString(node.from, node.to);
        add(node.from, node.to, sanitizeHtml(src));
        return false;
      }
      if (
        node.name === "Paragraph" ||
        node.name === "SetextHeading" ||
        /^ATXHeading[1-6]$/.test(node.name)
      ) {
        addRegions(node.from, node.to);
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
