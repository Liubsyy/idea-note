// Typora/Obsidian-style live preview for CodeMirror 6.
//
// The document is always markdown source. We walk the Lezer syntax tree and,
// for every line that the selection does NOT touch, hide the markdown markers
// and render the result (big headings, bold text, real images, …). On the
// line(s) the cursor is on, markers stay visible so you edit raw markdown —
// exactly the Typora hybrid behavior.

import {
  ensureSyntaxTree,
  syntaxTree,
  syntaxTreeAvailable,
} from "@codemirror/language";
import { EditorState, Range, StateEffect } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";

import { toDisplaySrc } from "../imagePath";
import { copyText } from "../clipboard";
import { useAppStore } from "../../store/useAppStore";
import { MathWidget } from "./math";
import { MERMAID_FENCE } from "./diagram";

/** Lines (1-based) the selection intersects — these reveal their source. */
function activeLineSet(state: EditorState): Set<number> {
  const set = new Set<number>();
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    const b = state.doc.lineAt(r.to).number;
    for (let n = a; n <= b; n++) set.add(n);
  }
  return set;
}

const FENCE_RE = /^\s*(`{3,}|~{3,})/;
/** An ATX heading line (`# ` … `###### `); group 1 is the `#`s (its level). */
const HEADING_RE = /^(#{1,6})\s/;
/** A line that begins with an image (spaced paths included). Used to drop the
 *  heading→body gap before an image, which renders as its own block. */
const IMAGE_LINE_RE = /^\s*!\[[^\]\n]*\]\([^)\n]+\)/;

/**
 * Interior line numbers of multi-line `$$ … $$` math blocks, where a blank line
 * is real math content rather than a block separator and so must keep its full
 * height. Mirrors the block scan in math.ts: a lone `$$` opens a block that the
 * next `$$` closes; code fences are tracked so a `$$` inside a code block isn't
 * mistaken for math.
 */
function mathBlockInteriorLines(state: EditorState): Set<number> {
  const set = new Set<number>();
  const doc = state.doc;
  let inFence = false;
  for (let i = 1; i <= doc.lines; i++) {
    const text = doc.line(i).text;
    if (FENCE_RE.test(text)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (text.trim() === "$$") {
      let j = i + 1;
      while (j <= doc.lines && doc.line(j).text.trim() !== "$$") {
        set.add(j);
        j++;
      }
      i = j; // resume after the closing `$$`
    }
  }
  return set;
}

/**
 * Block node names whose blank lines are literal content (code, raw HTML,
 * comments). A blank line anywhere inside one of these keeps its full height.
 */
const RAW_BLANK_BLOCKS = new Set([
  "FencedCode",
  "CodeBlock",
  "HTMLBlock",
  "CommentBlock",
]);

class ImageWidget extends WidgetType {
  constructor(
    readonly url: string,
    readonly alt: string,
    readonly title: string,
  ) {
    super();
  }
  eq(o: ImageWidget) {
    return o.url === this.url && o.alt === this.alt && o.title === this.title;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("span");
    wrap.className = "cm-md-image-wrap";

    const img = document.createElement("img");
    img.src = toDisplaySrc(this.url);
    img.alt = this.alt;
    img.className = "cm-md-image";
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";

    const fallback = document.createElement("span");
    fallback.className = "cm-md-image-error";
    fallback.textContent = `图片加载失败：${this.url}`;
    fallback.hidden = true;

    const requestMeasure = () => view.requestMeasure();
    img.addEventListener("load", requestMeasure);
    if (img.complete) queueMicrotask(requestMeasure);
    img.addEventListener("error", () => {
      img.hidden = true;
      fallback.hidden = false;
      requestMeasure();
    });

    wrap.append(img, fallback);

    // Caption shown under the image (Typora style): only when an explicit
    // `"title"` is given. No title means no caption.
    if (this.title) {
      const cap = document.createElement("span");
      cap.className = "cm-md-image-caption";
      cap.textContent = this.title;
      wrap.append(cap);
    }

    return wrap;
  }
  ignoreEvent() {
    return false;
  }
}

class BulletWidget extends WidgetType {
  constructor(readonly char: string) {
    super();
  }
  eq(o: BulletWidget) {
    return o.char === this.char;
  }
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-md-bullet";
    // Hollow (level ≥ 2) bullets are drawn with a thin CSS border-circle so the
    // ring line stays fine; the `◦` glyph renders too thick at this size.
    if (this.char === "◦") {
      s.classList.add("cm-md-bullet-hollow");
    } else {
      s.textContent = this.char;
    }
    return s;
  }
}

class CheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly pos: number, // offset of the char between the brackets
  ) {
    super();
  }
  eq(o: CheckboxWidget) {
    return o.checked === this.checked && o.pos === this.pos;
  }
  toDOM(view: EditorView) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = this.checked;
    box.className = "cm-md-task";
    // Toggle the source `x`/space directly instead of letting the browser flip
    // the box; the rebuild then re-renders it from the new doc state.
    box.addEventListener("mousedown", (e) => {
      e.preventDefault();
      view.dispatch({
        changes: {
          from: this.pos,
          to: this.pos + 1,
          insert: this.checked ? " " : "x",
        },
      });
    });
    return box;
  }
  ignoreEvent() {
    return false;
  }
}

class HrWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const hr = document.createElement("span");
    hr.className = "cm-md-hr";
    return hr;
  }
}

class BrWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    return document.createElement("br");
  }
}

/** A "copy" button floated in a code block's top-right corner. Copies the block
 *  body and briefly confirms (plus a toast). Anchored to the first code line,
 *  which CSS makes `position: relative`. */
class CopyButtonWidget extends WidgetType {
  constructor(readonly code: string) {
    super();
  }
  eq(o: CopyButtonWidget) {
    return o.code === this.code;
  }
  toDOM() {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cm-md-copy-btn";
    btn.textContent = "复制";
    btn.title = "复制代码";
    // Don't let the press move the editor cursor or steal focus.
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      void copyText(this.code)
        .then(() => {
          useAppStore.getState().showToast("已复制到剪贴板", "success");
          btn.textContent = "已复制";
          btn.classList.add("cm-md-copy-btn-done");
          window.setTimeout(() => {
            btn.textContent = "复制";
            btn.classList.remove("cm-md-copy-btn-done");
          }, 1200);
        })
        .catch(() => useAppStore.getState().showToast("复制失败", "error"));
    });
    return btn;
  }
  ignoreEvent() {
    return true;
  }
}

const HEADING_CLASS: Record<string, string> = {
  ATXHeading1: "cm-md-h1",
  ATXHeading2: "cm-md-h2",
  ATXHeading3: "cm-md-h3",
  ATXHeading4: "cm-md-h4",
  ATXHeading5: "cm-md-h5",
  ATXHeading6: "cm-md-h6",
};

function buildDecorations(view: EditorView): DecorationSet {
  const { state } = view;
  // Only reveal source on the cursor line while the editor is focused; an
  // unfocused editor (e.g. a freshly opened file) renders everything and shows
  // no caret. In read-only mode nothing is editable, so never swap a line back
  // to source — selecting rendered content keeps showing the rendered form.
  const active =
    view.hasFocus && !state.readOnly
      ? activeLineSet(state)
      : new Set<number>();
  const ranges: Range<Decoration>[] = [];

  // Markdown parsing is async/incremental: right after a file opens the tree
  // may not yet cover the whole doc. Force it forward (bounded) so blocks below
  // the parsed region render immediately instead of only after the first click.
  const tree =
    ensureSyntaxTree(state, state.doc.length, 50) ?? syntaxTree(state);

  const lineActive = (from: number, to: number) => {
    const a = state.doc.lineAt(from).number;
    const b = state.doc.lineAt(to).number;
    for (let n = a; n <= b; n++) if (active.has(n)) return true;
    return false;
  };

  const addLineClass = (from: number, to: number, cls: string) => {
    const a = state.doc.lineAt(from).number;
    const b = state.doc.lineAt(to).number;
    for (let n = a; n <= b; n++) {
      const line = state.doc.line(n);
      ranges.push(Decoration.line({ class: cls }).range(line.from));
    }
  };

  // Hide a marker, swallowing one trailing space (e.g. "## ").
  const hideMark = (from: number, to: number, eatSpace = false) => {
    let end = to;
    if (eatSpace && state.doc.sliceString(end, end + 1) === " ") end += 1;
    ranges.push(Decoration.replace({}).range(from, end));
  };

  // End of the range swallowed by a recovered spaced-image widget (see the
  // Image case). Such a widget covers text the tree parsed as separate inline
  // nodes, so we skip those to avoid overlapping replace decorations.
  let coveredTo = 0;

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name;
        const nFrom = node.from;
        const nTo = node.to;
        if (nFrom < coveredTo) return false;
        const revealed = lineActive(nFrom, nTo);

        // Block-level line styling
        if (HEADING_CLASS[name]) {
          addLineClass(nFrom, nTo, HEADING_CLASS[name]);
          return;
        }
        switch (name) {
          case "Blockquote": {
            // Only the outermost quote styles the lines; each line's nesting
            // depth (count of leading `>` markers) drives a progressive indent
            // so nested quotes step inward instead of collapsing to one level.
            if (node.node.parent?.name === "Blockquote") return;
            const a = state.doc.lineAt(nFrom).number;
            const b = state.doc.lineAt(nTo).number;
            for (let n = a; n <= b; n++) {
              const line = state.doc.line(n);
              const m = line.text.match(/^(?:\s*>)+/);
              const depth = m ? (m[0].match(/>/g) || []).length : 1;
              ranges.push(
                Decoration.line({
                  class: "cm-md-quote",
                  attributes: {
                    // The extra 1em is the gap between the bar and the text.
                    // It lives in the margin (not padding) so a native multi-
                    // line selection — which fills each line's box — doesn't
                    // highlight the gap to the left of the text. The bar is
                    // drawn by the .cm-md-quote::before in that margin.
                    style: `margin-left:calc(var(--md-block-indent) + 1em + ${(depth - 1) * 1.2}em)`,
                  },
                }).range(line.from),
              );
            }
            return;
          }
          case "LinkReference":
            // A `[ref]: url` definition produces no rendered output; hide the
            // whole line unless the cursor is on it.
            if (!revealed) addLineClass(nFrom, nTo, "cm-md-hidden");
            return;
          case "FencedCode":
          case "CodeBlock": {
            const a = state.doc.lineAt(nFrom).number;
            const b = state.doc.lineAt(nTo).number;
            const fenced = name === "FencedCode";
            // Reveal the ``` fences whenever the cursor is anywhere inside the
            // block (not only on the fence line itself — which is collapsed and
            // unreachable), so you can see and edit the full source.
            let blockActive = false;
            for (let n = a; n <= b; n++)
              if (active.has(n)) {
                blockActive = true;
                break;
              }
            // A ```mermaid block renders as a diagram (mermaidBlock StateField)
            // when the cursor is outside it; skip the code styling so the two
            // don't overlap. Inside the block we fall through to show source.
            if (
              fenced &&
              !blockActive &&
              MERMAID_FENCE.test(state.doc.line(a).text)
            )
              return;
            // A block with no info-string (or an indented CodeBlock) has no
            // language: its whole body is tagged `monospace` and would render
            // in the orange accent. Mark those lines so CSS can fall back to
            // the neutral --code-text, matching language-highlighted blocks.
            const infoMatch = fenced
              ? state.doc.line(a).text.match(/^\s*(?:`{3,}|~{3,})\s*([^\s`]*)/)
              : null;
            const plain = !fenced || !infoMatch || infoMatch[1].length === 0;
            const codeLines: number[] = [];
            for (let n = a; n <= b; n++) {
              const ln = state.doc.line(n);
              // Fence (``` / ~~~) lines: collapsed while the cursor is outside
              // the block, revealed once it's inside.
              if (fenced && /^\s*(`{3,}|~{3,})/.test(ln.text)) {
                ranges.push(
                  Decoration.line({
                    class: blockActive
                      ? "cm-md-codeblock"
                      : "cm-md-codeblock cm-code-fence",
                  }).range(ln.from),
                );
              } else {
                codeLines.push(n);
              }
            }
            // Number the real code lines (1-based, per block) for the gutter.
            codeLines.forEach((n, i) => {
              const ln = state.doc.line(n);
              const cls =
                "cm-md-codeblock cm-code-line" +
                (plain ? " cm-code-plain" : "") +
                (i === 0 ? " cm-code-first" : "") +
                (i === codeLines.length - 1 ? " cm-code-last" : "");
              ranges.push(
                Decoration.line({
                  class: cls,
                  attributes: { "data-ln": String(i + 1) },
                }).range(ln.from),
              );
            });
            // A copy button in the block's top-right (anchored to the first code
            // line). Indented CodeBlocks carry a 4-space/tab indent — strip it so
            // the copied text is the bare code.
            if (codeLines.length > 0) {
              const code = codeLines
                .map((n) => {
                  const t = state.doc.line(n).text;
                  return fenced ? t : t.replace(/^( {1,4}|\t)/, "");
                })
                .join("\n");
              ranges.push(
                Decoration.widget({
                  widget: new CopyButtonWidget(code),
                  side: -1,
                }).range(state.doc.line(codeLines[0]).from),
              );
            }
            return;
          }
        }

        if (revealed) return; // show raw source on the active line(s)

        switch (name) {
          case "HeaderMark":
            hideMark(nFrom, nTo, true);
            break;
          case "EmphasisMark":
          case "StrikethroughMark":
          case "CodeMark":
          case "QuoteMark":
            hideMark(nFrom, nTo, name === "QuoteMark");
            break;
          case "LinkMark":
            hideMark(nFrom, nTo);
            break;
          case "LinkTitle": // the "title" in [t](url "title")
          case "LinkLabel": // the [ref] in a reference-style link
            hideMark(nFrom, nTo);
            break;
          case "Escape":
            // `\*` -> `*`: drop the backslash, keep the escaped char.
            hideMark(nFrom, nFrom + 1);
            break;
          case "InlineMath": {
            // `$...$` -> rendered KaTeX (strip the surrounding `$`). Inline
            // replace decorations may not cross a line break, and real inline
            // math never does, so skip a `$…$` that the parser paired across
            // lines (e.g. prose like "$path1 … $path2") — leave it as source.
            if (state.doc.lineAt(nFrom).number !== state.doc.lineAt(nTo).number)
              break;
            const tex = state.doc.sliceString(nFrom + 1, nTo - 1);
            ranges.push(
              Decoration.replace({
                widget: new MathWidget(tex, false),
              }).range(nFrom, nTo),
            );
            break;
          }
          case "URL":
            // hide the (url) part of links, but not bare autolinks
            if (node.node.parent?.name === "Link") hideMark(nFrom, nTo);
            break;
          case "ListMark": {
            const list = node.node.parent?.parent; // ListItem -> Bullet/OrderedList
            if (
              list &&
              (list.name === "BulletList" || list.name === "OrderedList")
            ) {
              // Nesting depth = number of ancestor lists. Indent is derived from
              // this (not the source's leading spaces), so items at the same
              // level always line up regardless of how the source is indented.
              let depth = 0;
              for (let p: typeof list | null = list; p; p = p.parent)
                if (p.name === "BulletList" || p.name === "OrderedList") depth++;
              const line = state.doc.lineAt(nFrom);
              // Hide the source indent whitespace before the marker.
              if (nFrom > line.from)
                ranges.push(Decoration.replace({}).range(line.from, nFrom));
              // Task-list items (`- [x]`) show a checkbox instead of a bullet.
              const isTask = node.node.nextSibling?.name === "Task";
              // Hanging indent: pad the line by the marker's rendered width and
              // pull the first line back by the same amount with a negative
              // text-indent. The marker still sits at the list indent, but a
              // soft-wrapped continuation line aligns under the item text
              // instead of falling back to the bullet/number column.
              const ordered = list.name === "OrderedList";
              const markerLen = nTo - nFrom; // "-"→1, "1."→2, "10."→3, …
              const hangEm = ordered
                ? markerLen * 0.55 + 0.35
                : isTask
                  ? 1.5
                  : 1.3;
              ranges.push(
                Decoration.line({
                  class: "cm-md-list",
                  attributes: {
                    style: `padding-left:calc(var(--md-block-indent) + ${(depth - 1) * 1.4}em + ${hangEm}em);text-indent:-${hangEm}em`,
                  },
                }).range(line.from),
              );
              if (list.name === "BulletList" && !isTask)
                ranges.push(
                  // Level 1 solid •, deeper levels hollow ◦.
                  Decoration.replace({
                    widget: new BulletWidget(depth >= 2 ? "◦" : "•"),
                  }).range(nFrom, nTo),
                );
              else if (list.name === "BulletList" && isTask)
                // Task items show a checkbox in place of the bullet, so hide
                // the raw `-` marker entirely.
                hideMark(nFrom, nTo);
              else if (list.name === "OrderedList")
                // Ordered marker keeps its `1.` text; add a gap after it so the
                // spacing matches the bullet list.
                ranges.push(
                  Decoration.mark({ class: "cm-md-ol-mark" }).range(nFrom, nTo),
                );
            }
            break;
          }
          case "TaskMarker": {
            // `[x]` / `[ ]` -> checkbox; nFrom+1 is the char between brackets.
            const checked = /x/i.test(state.doc.sliceString(nFrom, nTo));
            ranges.push(
              Decoration.replace({
                widget: new CheckboxWidget(checked, nFrom + 1),
              }).range(nFrom, nTo),
            );
            break;
          }
          case "HorizontalRule":
            ranges.push(
              Decoration.replace({ widget: new HrWidget() }).range(nFrom, nTo),
            );
            break;
          case "HTMLTag": {
            const tag = state.doc.sliceString(nFrom, nTo);
            if (!/^<br\s*\/?>$/i.test(tag)) break;
            const line = state.doc.lineAt(nFrom);
            const lineRemainder = state.doc.sliceString(nTo, line.to);
            if (lineRemainder.trim() === "") {
              ranges.push(Decoration.replace({}).range(nFrom, line.to));
            } else {
              ranges.push(
                Decoration.replace({ widget: new BrWidget() }).range(nFrom, nTo),
              );
            }
            break;
          }
          case "Image": {
            const n = node.node;
            const titleNode = n.getChild("LinkTitle");
            // LinkTitle includes the surrounding quotes/parens; strip them.
            const title = titleNode
              ? state.doc.sliceString(titleNode.from + 1, titleNode.to - 1)
              : "";
            const urlNode = n.getChild("URL");
            if (urlNode) {
              const url = state.doc.sliceString(urlNode.from, urlNode.to);
              const alt = state.doc.sliceString(n.from + 2, n.to).split("]")[0];
              if (url) {
                ranges.push(
                  Decoration.replace({
                    widget: new ImageWidget(url, alt, title),
                  }).range(nFrom, nTo),
                );
              }
              break;
            }
            // No URL child: a raw space in the destination is invalid CommonMark,
            // so Lezer bails and leaves an Image node spanning only "![]".
            // Recover the full ![alt](dest) by hand so Typora-style spaced paths
            // still render (toDisplaySrc also handles <…> and %20 forms).
            const lineTo = state.doc.lineAt(nFrom).to;
            const m = /^!\[([^\]\n]*)\]\(([^)\n]+)\)/.exec(
              state.doc.sliceString(nFrom, lineTo),
            );
            if (m) {
              const imgTo = nFrom + m[0].length;
              ranges.push(
                Decoration.replace({
                  widget: new ImageWidget(m[2].trim(), m[1], title),
                }).range(nFrom, imgTo),
              );
              // The widget covers the "![]" marks plus text the tree parsed as
              // separate inline nodes; skip them all to avoid overlap.
              coveredTo = imgTo;
              return false;
            }
            break;
          }
        }
      },
    });
  }

  // Per-line vertical-rhythm tweaks, one scan over the visible lines:
  //   * Typora-style blank-line collapse — a blank line that merely separates
  //     two blocks renders as a compact gap instead of a full empty row, so the
  //     pair reads as one clean break. Skipped (full height) when the blank is
  //     real content (inside a code / HTML / math block) or the cursor sits on
  //     it, so it stays editable.
  //   * The first content line after a heading gets extra top padding, so the
  //     heading sits apart from its body text. This lives on the content line
  //     (not the heading or a blank) so it works even when the source has no
  //     blank line after the heading, and `padding` keeps CodeMirror's caret
  //     geometry correct (a line `margin` would desync coordsAtPos/posAtCoords).
  const mathInterior = mathBlockInteriorLines(state);
  for (const { from, to } of view.visibleRanges) {
    const first = state.doc.lineAt(from).number;
    const last = state.doc.lineAt(to).number;
    for (let n = first; n <= last; n++) {
      const line = state.doc.line(n);
      if (line.text.trim() === "") {
        // A blank line inside a math block keeps its full height (it's real
        // content). Otherwise it always collapses to a compact gap — including
        // when the cursor sits on it, so clicking into a paragraph separator
        // doesn't pop it back open to a full empty row (a visible "double"
        // break). The caret just renders at the collapsed line's height.
        if (mathInterior.has(n)) continue;
        let raw = false;
        for (
          let node: SyntaxNode | null = tree.resolveInner(line.from, 1);
          node;
          node = node.parent
        ) {
          if (RAW_BLANK_BLOCKS.has(node.name)) {
            raw = true;
            break;
          }
        }
        if (!raw)
          ranges.push(
            Decoration.line({ class: "cm-md-blank" }).range(line.from),
          );
      } else {
        const isImage = IMAGE_LINE_RE.test(line.text);
        // Image line: hide CodeMirror's widget-buffer <img>s (see editor.css).
        // They occupy an inline line box at the line's line-height, floating the
        // (block) image down by ~one line below the preceding text. Skipped while
        // the cursor sits on the line — it shows raw source then, with no widget.
        if (isImage && !active.has(n))
          ranges.push(
            Decoration.line({ class: "cm-md-image-line" }).range(line.from),
          );
        // Any non-blank line — body text OR a following heading: if the nearest
        // non-blank line above is a heading, tag it with that heading's level so
        // CSS sizes the gap per level. Keying off the heading *above* means the
        // gap is owned by the upper heading, so e.g. an H1 directly followed by
        // an H2 gets the H1-sized gap between them.
        let p = n - 1;
        while (p >= 1 && state.doc.line(p).text.trim() === "") p--;
        const aboveLine = p >= 1 ? state.doc.line(p) : null;
        const above = aboveLine ? aboveLine.text.match(HEADING_RE) : null;
        // Skip the gap when the body is an image — it renders as its own block,
        // so the heading→text breathing room just leaves it floating far below.
        if (above && !isImage)
          ranges.push(
            Decoration.line({
              class: `cm-md-after-h${above[1].length}`,
            }).range(line.from),
          );
        // Top gap above a heading that follows non-heading content (body, list,
        // …). Sized by the heading's own level. Skipped when the line above is
        // itself a heading (that pair already gets the `after-h` gap, so we'd
        // otherwise double it) and at the document's very top (no content above).
        const self = line.text.match(HEADING_RE);
        if (self && aboveLine && !above)
          ranges.push(
            Decoration.line({
              class: `cm-md-before-h${self[1].length}`,
            }).range(line.from),
          );
      }
    }
  }

  // Inline emphasis styling is applied regardless of reveal so text stays
  // bold/italic even while you edit its markers.
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        const cls = INLINE_CLASS[node.name];
        if (cls) ranges.push(Decoration.mark({ class: cls }).range(node.from, node.to));
      },
    });
  }

  return Decoration.set(ranges, true);
}

const INLINE_CLASS: Record<string, string> = {
  StrongEmphasis: "cm-md-strong",
  Emphasis: "cm-md-em",
  Strikethrough: "cm-md-strike",
  InlineCode: "cm-md-code",
  Link: "cm-md-link",
  Autolink: "cm-md-link",
};

export const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(u: ViewUpdate) {
      if (
        u.docChanged ||
        u.selectionSet ||
        u.viewportChanged ||
        u.focusChanged ||
        // Switching in/out of read-only mode changes whether the cursor line is
        // revealed as source, so rebuild when the readOnly facet toggles.
        u.startState.readOnly !== u.state.readOnly ||
        u.transactions.some((t) => t.effects.some((e) => e.is(parseAdvanced)))
      ) {
        this.decorations = buildDecorations(u.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
  },
);

/**
 * Dispatched by {@link syntaxParseDriver} once async parsing has advanced, so
 * decoration providers rebuild even though the doc/selection didn't change.
 */
export const parseAdvanced = StateEffect.define<null>();

/**
 * Drives the incremental markdown parser to completion after a file opens.
 *
 * CodeMirror parses lazily in the background and doesn't emit a doc/selection
 * transaction when it advances, so StateField-backed decorations (tables) would
 * otherwise not appear until the user interacts. This nudges parsing forward and
 * fires {@link parseAdvanced} so providers rebuild, until the whole doc is
 * parsed.
 */
export const syntaxParseDriver = ViewPlugin.fromClass(
  class {
    timer: ReturnType<typeof setTimeout> | undefined;
    constructor(view: EditorView) {
      this.tick(view);
    }
    update(u: ViewUpdate) {
      // A newly loaded document needs parsing again.
      if (u.docChanged) this.tick(u.view);
    }
    tick(view: EditorView) {
      clearTimeout(this.timer);
      const end = view.state.doc.length;
      if (syntaxTreeAvailable(view.state, end)) return;
      this.timer = setTimeout(() => {
        if (!view.dom.isConnected) return;
        ensureSyntaxTree(view.state, end, 100);
        view.dispatch({ effects: parseAdvanced.of(null) });
        this.tick(view);
      }, 0);
    }
    destroy() {
      clearTimeout(this.timer);
    }
  },
);
