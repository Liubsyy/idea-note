// Formatting active at the cursor, derived from the CodeMirror markdown syntax
// tree. Drives the toolbar button highlights.

import type { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";

import { findSpanAt } from "./spanStyle";
import { imageAt } from "./imageAt";
import {
  highlightColorFromLine,
  type HighlightColor,
} from "../highlightBlock";

export interface ActiveFormats {
  bold: boolean;
  italic: boolean;
  strike: boolean;
  code: boolean;
  link: boolean;
  /** Cursor sits on an image, so the toolbar's image button edits that one. */
  image: boolean;
  blockquote: boolean;
  highlightBlock: boolean;
  highlightColor: HighlightColor | null;
  bulletList: boolean;
  orderedList: boolean;
  codeBlock: boolean;
  /** Active heading level (1–6), or 0 when not in a heading. */
  heading: number;
  /** Colours of the `<span>` around the cursor, null when it has none. */
  textColor: string | null;
  bgColor: string | null;
}

export const emptyFormats: ActiveFormats = {
  bold: false,
  italic: false,
  strike: false,
  code: false,
  link: false,
  image: false,
  blockquote: false,
  highlightBlock: false,
  highlightColor: null,
  bulletList: false,
  orderedList: false,
  codeBlock: false,
  heading: 0,
  textColor: null,
  bgColor: null,
};

export function computeActiveFormats(state: EditorState): ActiveFormats {
  const result: ActiveFormats = { ...emptyFormats };
  const range = state.selection.main;
  const pos = range.head;

  // Colours come from the raw `<span style>` around the selection: the markdown
  // tree parses it as a bare HTMLTag, with no attributes to read.
  const span = findSpanAt(state, range.from, range.to);
  if (span) {
    result.textColor = span.style.get("color") ?? null;
    result.bgColor = span.style.get("background-color") ?? null;
  }

  // Scanned separately: a sized or spaced destination defeats Lezer's image
  // parse, so the tree alone would miss exactly those images.
  result.image = imageAt(state, pos) !== null;

  let node: ReturnType<typeof syntaxTree>["topNode"] | null =
    syntaxTree(state).resolveInner(pos, -1);

  while (node) {
    switch (node.name) {
      case "StrongEmphasis":
        result.bold = true;
        break;
      case "Emphasis":
        result.italic = true;
        break;
      case "Strikethrough":
        result.strike = true;
        break;
      case "InlineCode":
        result.code = true;
        break;
      case "Link":
        result.link = true;
        break;
      case "Blockquote":
        result.blockquote = true;
        {
          const color = highlightColorFromLine(
            state.doc.lineAt(node.from).text,
          );
          if (color) {
            result.highlightBlock = true;
            result.highlightColor = color;
          }
        }
        break;
      case "BulletList":
        result.bulletList = true;
        break;
      case "OrderedList":
        result.orderedList = true;
        break;
      case "FencedCode":
      case "CodeBlock":
        result.codeBlock = true;
        break;
      case "ATXHeading1":
        result.heading = 1;
        break;
      case "ATXHeading2":
        result.heading = 2;
        break;
      case "ATXHeading3":
        result.heading = 3;
        break;
      case "ATXHeading4":
        result.heading = 4;
        break;
      case "ATXHeading5":
        result.heading = 5;
        break;
      case "ATXHeading6":
        result.heading = 6;
        break;
    }
    node = node.parent;
  }
  return result;
}
