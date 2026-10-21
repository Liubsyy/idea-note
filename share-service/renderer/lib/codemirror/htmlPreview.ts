import { tr } from "../../i18n/core.ts";
import { localizeElement } from "../../i18n/dom.ts";
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
// Details blocks keep their native expand/collapse interaction; only the
// explicit left-side source button reveals their HTML, matching table preview.

import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorState, StateField, Range, type Extension } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";

import {
  blockHeightKey,
  estimatedBlockHeight,
  trackBlockHeight,
  untrackBlockHeight,
} from "./blockHeight";
import { codeRunnersChanged, parseAdvanced } from "./livePreview";
import { renderInlineHtml, sanitizeHtml } from "./inlineHtml";
import { toDisplaySrc } from "../imagePath";
import { cssLength, getImgAttr, parseImgTag } from "../imageSyntax";
import { bindResourcePreview, resourceSelected, resourceSourceVisible, setResourceSource } from "./resourcePreview";
import { openImagePrompt } from "./markdownActions";
import { setDetailsSource, type DetailsRange } from "./detailsBlock";
import { enhanceDetailsMarkdown, refreshDetailsCodeActions, renderDetailsMarkdown } from "./detailsMarkdown";
import { openLinkTargetSafe } from "./linkClick";
import { destroyCodeActions } from "./codeActions";
import { useAppStore } from "../../store/useAppStore";
import { canInteract } from "./interaction";

type HtmlImage = { from: number; to: number; url: string; selected: boolean; readOnly: boolean };
type HtmlDetails = DetailsRange & { readOnly: boolean; controlsKey: string };

const detailsSourceField = StateField.define<DetailsRange | null>({
  create: () => null,
  update(value, transaction) {
    if (transaction.state.readOnly) return null;
    for (const effect of transaction.effects)
      if (effect.is(setDetailsSource)) return effect.value;
    if (!value) return null;
    const mapped = transaction.docChanged ? {
      from: transaction.changes.mapPos(value.from, -1),
      to: transaction.changes.mapPos(value.to, 1),
    } : value;
    // Match tables: keep source visible during editing, then render on exit.
    if (transaction.selection && !transaction.state.selection.ranges.some(
      (range) => range.from <= mapped.to && range.to >= mapped.from,
    )) return null;
    return mapped;
  },
});

// Reuse the native details DOM across selection/position changes so its open
// state survives. Event handlers read the current range instead of old offsets.
const detailsHosts = new WeakMap<HTMLElement, HtmlDetails>();
const SOURCE_ICON =
  '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m18 16 4-4-4-4" /><path d="m6 8-4 4 4 4" /><path d="m14.5 4-5 16" /></svg>';

function bindDetails(el: HTMLElement, view: EditorView, details: HtmlDetails) {
  detailsHosts.set(el, details);
  el.classList.add("cm-md-details");
  enhanceDetailsMarkdown(el, view, () => view.requestMeasure());
  // Widget events bypass the editor's normal link handler. Resolve local files
  // and external URLs through the same opener as ordinary Markdown links.
  el.addEventListener("click", (event) => {
    const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!link) return;
    event.preventDefault();
    if (event.metaKey || event.ctrlKey || detailsHosts.get(el)?.readOnly)
      openLinkTargetSafe(link.getAttribute("href")!);
  });
  // HTML headings and Markdown headings rendered inside the widget do not
  // pass through livePreview's line decorations. Reuse its heading typography
  // here, including nested details, while summary headings inherit from their
  // separately styled disclosure row below.
  el.querySelectorAll("h1, h2, h3, h4, h5, h6").forEach((heading) => {
    if (!heading.closest("summary"))
      heading.classList.add("cm-md-details-heading", `cm-md-h${heading.tagName.slice(1)}`);
  });
  // Tailwind resets native heading typography. Style the summary itself with
  // the editor's heading class so its text and disclosure marker share the
  // same size, weight, line height, and user-configured heading scale.
  el.querySelectorAll("summary").forEach((summary) => {
    const heading = Array.from(summary.children).find((child) => /^H[1-6]$/.test(child.tagName));
    if (heading) summary.classList.add(`cm-md-h${heading.tagName.slice(1)}`);
    summary.addEventListener("click", (event) => {
      if (event.defaultPrevented ||
        (event.target instanceof Element && event.target.closest("a, button, input, select, textarea"))) return;
      // Capture before the native click toggles `open`. Otherwise CodeMirror's
      // height measurement can anchor to the document bottom and move the
      // summary by the entire height of its body, especially beside a tall
      // table. An explicit snapshot takes priority over that automatic anchor.
      // Keep the native default so mouse and keyboard toggles work alike.
      view.dispatch({ effects: view.scrollSnapshot() });
    });
  });
  el.querySelectorAll("details").forEach((element) => {
    element.addEventListener("toggle", () => view.requestMeasure());
  });
  if (details.readOnly) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "cm-md-details-source";
  localizeElement(button, "title", () => tr("显示折叠块源码"));
  localizeElement(button, "ariaLabel", () => tr("显示折叠块源码"));
  button.innerHTML = SOURCE_ICON;
  for (const type of ["pointerdown", "mousedown", "touchstart"] as const)
    button.addEventListener(type, (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const range = detailsHosts.get(el)!;
    view.dispatch({
      selection: { anchor: range.from },
      effects: setDetailsSource.of({ from: range.from, to: range.to }),
    });
    view.focus();
  });
  el.appendChild(button);
}

function singleImage(state: EditorState, from: number, to: number): HtmlImage | undefined {
  const source = state.sliceDoc(from, to);
  const tag = source.trim();
  if (!/^<img\b[^<>]*>$/i.test(tag)) return;
  const start = from + source.indexOf("<");
  const end = start + tag.length;
  const url = getImgAttr(parseImgTag(tag), "src");
  if (!url) return;
  return { from: start, to: end, url, selected: resourceSelected(state, start, end), readOnly: state.readOnly };
}

class HtmlWidget extends WidgetType {
  constructor(
    readonly html: string, // already sanitized
    readonly from: number,
    // Inline tags inside a list item / blockquote render as a <span> so the
    // line (bullet, indent) is preserved; block HTML and top-level paragraphs
    // render as a <div>.
    readonly inline = false,
    readonly image?: HtmlImage,
    readonly details?: HtmlDetails,
  ) {
    super();
  }
  eq(o: HtmlWidget) {
    return o.image?.selected === this.image?.selected && this.sameRender(o);
  }
  sameRender(o: HtmlWidget) {
    return o.html === this.html && o.from === this.from && o.inline === this.inline &&
      o.image?.from === this.image?.from && o.image?.to === this.image?.to &&
      o.image?.readOnly === this.image?.readOnly &&
      o.details?.from === this.details?.from && o.details?.to === this.details?.to &&
      o.details?.controlsKey === this.details?.controlsKey &&
      o.details?.readOnly === this.details?.readOnly;
  }
  // Selecting an image only restyles its outline; a rebuilt <img> would lay
  // out at zero height until it decodes and flash (see ImageWidget).
  updateDOM(dom: HTMLElement, view: EditorView, prev: HtmlWidget) {
    if (this.details && prev.details && this.html === prev.html &&
      this.details.readOnly === prev.details.readOnly) {
      detailsHosts.set(dom, this.details);
      if (this.details.controlsKey !== prev.details.controlsKey)
        refreshDetailsCodeActions(dom, view, () => view.requestMeasure());
      return true;
    }
    if (!this.image || !this.sameRender(prev)) return false;
    dom.classList.toggle("cm-md-resource-selected", this.image.selected);
    return true;
  }
  // Stand-in height until CodeMirror measures the real DOM; see blockHeight.ts.
  // Only the block form gets one — an inline widget is measured as part of its
  // line, where a height of its own would change how the line is sized.
  get estimatedHeight() {
    return this.inline
      ? -1
      : estimatedBlockHeight(blockHeightKey("html", this.from));
  }
  toDOM(view: EditorView) {
    const el = document.createElement(this.inline ? "span" : "div");
    el.className = this.inline ? "cm-md-html-inline" : "cm-md-html";
    el.innerHTML = this.html;
    el.querySelectorAll("img").forEach((img) => {
      // innerHTML keeps the src verbatim; rewrite local paths to the asset
      // protocol (remote URLs pass through) so <img> matches Markdown images.
      const raw = img.getAttribute("src");
      if (this.image) img.draggable = false;
      if (raw) img.src = toDisplaySrc(raw);
      // width/height are presentational hints, which lose to Tailwind
      // preflight's `img { height: auto }`; restate them as inline styles so an
      // explicit size in the note actually applies (max-width still clamps).
      const w = img.getAttribute("width");
      const h = img.getAttribute("height");
      if (w) img.style.width = cssLength(w);
      if (h) img.style.height = cssLength(h);
      const requestMeasure = () => view.requestMeasure();
      img.addEventListener("load", requestMeasure);
      img.addEventListener("error", requestMeasure);
      if (img.complete) queueMicrotask(requestMeasure);
    });
    if (this.image) {
      el.classList.add("cm-md-image-wrap");
      bindResourcePreview(el, view, this.image, this.image.url, tr("图片"), this.image.selected,
        () => openImagePrompt(view));
    } else if (this.details) bindDetails(el, view, this.details);
    else el.addEventListener("mousedown", (e) => {
      // Let links/checkboxes inside the rendered HTML behave normally.
      if ((e.target as HTMLElement).closest("a")) return;
      e.preventDefault();
      view.dispatch({ selection: { anchor: this.from } });
      view.focus();
    });
    if (!this.inline)
      trackBlockHeight(el, () => blockHeightKey("html", detailsHosts.get(el)?.from ?? this.from));
    return el;
  }
  destroy(dom: HTMLElement) {
    dom.querySelectorAll<HTMLElement>(".cm-md-code-header").forEach(destroyCodeActions);
    untrackBlockHeight(dom);
  }
  ignoreEvent() {
    return !!this.image || !!this.details;
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
    const image = singleImage(state, nodeFrom, nodeTo);
    const details = /^\s*<details\b/i.test(state.sliceDoc(nodeFrom, nodeTo))
      ? { from, to, readOnly: state.readOnly,
        controlsKey: `${canInteract(state)}:${JSON.stringify(useAppStore.getState().codeRunConfig)}` } : undefined;
    const source = state.field(detailsSourceField);
    // Ordinary HTML reveals source when selected; details and images require
    // their explicit source button. Read-only HTML always stays rendered.
    const inside =
      !state.readOnly &&
      state.selection.ranges.some((r) => r.from <= to && r.to >= from);
    const sourceVisible = image ? resourceSourceVisible(state, image.from)
      : details ? !state.readOnly && source?.from === from && source.to === to
      : inside;
    if (sourceVisible) return;
    ranges.push(
      Decoration.replace({
        widget: new HtmlWidget(html, from, false, image, details),
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
        const image = singleImage(state, region.from, region.to);
        const active =
          !state.readOnly &&
          state.selection.ranges.some(
            (r) => r.from <= region.to && r.to >= region.from,
          );
        if (image ? resourceSourceVisible(state, image.from) : active) continue;
        if (image && line.text.trim() === state.sliceDoc(region.from, region.to))
          ranges.push(Decoration.line({ class: "cm-md-image-line" }).range(line.from));
        ranges.push(
          Decoration.replace({
            widget: new HtmlWidget(
              sanitizeHtml(
                renderInlineHtml(state.doc.sliceString(region.from, region.to)),
              ),
              region.from,
              true,
              image,
            ),
          }).range(region.from, region.to),
        );
      }
    }
  };

  tree.iterate({
    enter: (node) => {
      if (node.name === "HTMLBlock") {
        const src = state.doc.sliceString(node.from, node.to);
        const html = /^\s*<details\b/i.test(src) ? renderDetailsMarkdown(src) : src;
        add(node.from, node.to, sanitizeHtml(html));
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

const htmlDecorations = StateField.define<DecorationSet>({
  create: (state) => buildHtml(state),
  update(deco, tr) {
    if (
      tr.docChanged ||
      tr.selection ||
      tr.startState.readOnly !== tr.state.readOnly ||
      tr.effects.some((e) => e.is(parseAdvanced) || e.is(codeRunnersChanged) || e.is(setResourceSource) || e.is(setDetailsSource))
    )
      return buildHtml(tr.state);
    return deco.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

export const htmlPreview: Extension = [detailsSourceField, htmlDecorations];
