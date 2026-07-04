// Formatting active at the cursor, derived from the CodeMirror markdown syntax
// tree. Drives the toolbar button highlights.

import type { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";

export interface ActiveFormats {
  bold: boolean;
  italic: boolean;
  strike: boolean;
  code: boolean;
  link: boolean;
  blockquote: boolean;
  bulletList: boolean;
  orderedList: boolean;
  codeBlock: boolean;
  /** Active heading level (1–6), or 0 when not in a heading. */
  heading: number;
}

export const emptyFormats: ActiveFormats = {
  bold: false,
  italic: false,
  strike: false,
  code: false,
  link: false,
  blockquote: false,
  bulletList: false,
  orderedList: false,
  codeBlock: false,
  heading: 0,
};

export function computeActiveFormats(state: EditorState): ActiveFormats {
  const result: ActiveFormats = { ...emptyFormats };
  const pos = state.selection.main.head;
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
