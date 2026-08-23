// The image under the cursor — `![alt](…)` or an `<img …>` tag — for the
// toolbar's active state and for the image dialog, which edits that image in
// place instead of inserting a second one.

import type { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";

import {
  getImgAttr,
  IMG_TAG_RE,
  parseImageDest,
  parseImgTag,
  unwrapImageDest,
  type ImageSize,
  type ImgAttr,
} from "../imageSyntax";

export interface ImageAtCursor {
  /** Document range of the whole `![alt](…)` or `<img …>`. */
  from: number;
  to: number;
  /** Which of the two forms the source uses. */
  kind: "markdown" | "html";
  alt: string;
  /** Markdown form: the destination as written, `<…>` wrapper and all. */
  dest: string;
  /** The path itself — what the dialog shows and the user edits. */
  url: string;
  title: string;
  size: ImageSize;
  /** HTML form: every attribute of the tag, so hand-written ones survive an
   *  edit. Empty for the markdown form. */
  attrs: ImgAttr[];
}

/** Scanned over the line rather than read off the syntax tree: a spaced path or
 *  an explicit size makes Lezer give up on the image (see livePreview.ts), so
 *  the tree only covers the plain forms. */
const IMAGE_RE = /!\[([^\]\n]*)\]\(([^)\n]*)\)/g;

/** Blocks whose text is literal, where `![](x)` is content and not an image. */
const RAW_NODES = new Set([
  "FencedCode",
  "CodeBlock",
  "InlineCode",
  "CommentBlock",
  "Comment",
]);

function inRawNode(state: EditorState, pos: number): boolean {
  for (
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1);
    node;
    node = node.parent
  ) {
    if (RAW_NODES.has(node.name)) return true;
  }
  return false;
}

/**
 * The image containing `pos`, or null. Both ends count as inside, so clicking a
 * rendered image — which puts the caret at one edge of the widget — still
 * selects it.
 */
export function imageAt(state: EditorState, pos: number): ImageAtCursor | null {
  const line = state.doc.lineAt(pos);
  const hit = (re: RegExp) => {
    re.lastIndex = 0;
    for (let m = re.exec(line.text); m; m = re.exec(line.text)) {
      const from = line.from + m.index;
      if (pos >= from && pos <= from + m[0].length) return m;
    }
    return null;
  };

  const md = hit(IMAGE_RE);
  if (md) {
    if (inRawNode(state, line.from + md.index)) return null;
    const { dest, size, title } = parseImageDest(md[2]);
    if (!dest) return null;
    return {
      from: line.from + md.index,
      to: line.from + md.index + md[0].length,
      kind: "markdown",
      alt: md[1],
      dest,
      url: unwrapImageDest(dest),
      title,
      size,
      attrs: [],
    };
  }

  const tag = hit(IMG_TAG_RE);
  if (tag) {
    if (inRawNode(state, line.from + tag.index)) return null;
    const attrs = parseImgTag(tag[0]);
    const url = getImgAttr(attrs, "src");
    if (!url) return null;
    return {
      from: line.from + tag.index,
      to: line.from + tag.index + tag[0].length,
      kind: "html",
      alt: getImgAttr(attrs, "alt"),
      dest: url,
      url,
      title: getImgAttr(attrs, "title"),
      size: {
        width: getImgAttr(attrs, "width"),
        height: getImgAttr(attrs, "height"),
      },
      attrs,
    };
  }
  return null;
}
