import type { MarkdownConfig } from "@lezer/markdown";
import { StateEffect } from "@codemirror/state";

export type DetailsRange = { from: number; to: number };
export const setDetailsSource = StateEffect.define<DetailsRange>();

/** Keep a top-level details element together across Markdown's HTML-block
 * blank-line boundaries. Other preview plugins then see one opaque HTMLBlock
 * instead of competing widgets for its lists, tables, or code fences. */
export const detailsBlock: MarkdownConfig = {
  parseBlock: [{
    name: "DetailsBlock",
    before: "HTMLBlock",
    parse(context, line) {
      if (context.parentType().name !== "Document" ||
        !/^<details(?:\s|>)/i.test(line.text.slice(line.pos))) return false;
      const from = context.lineStart + line.pos;
      let depth = 0;
      let comment = false;
      let rawTag = "";
      let fence = "";
      const tokens = /<!--|-->|`+|<\/?(?:details|pre|script|style|textarea)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi;
      do {
        const codeFence = !comment && !rawTag && /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line.text);
        if (codeFence) {
          if (!fence) fence = codeFence[1];
          else if (codeFence[1][0] === fence[0] && codeFence[1].length >= fence.length && !codeFence[2].trim()) fence = "";
        } else if (!fence && (comment || rawTag || !/^(?: {4}|\t)/.test(line.text))) {
          tokens.lastIndex = 0;
          let token: RegExpExecArray | null;
          while ((token = tokens.exec(line.text))) {
            const text = token[0];
            if (comment) {
              if (text === "-->") comment = false;
              continue;
            }
            if (rawTag) {
              if (new RegExp(`^</${rawTag}\\s*>$`, "i").test(text)) rawTag = "";
              continue;
            }
            if (text === "<!--") { comment = true; continue; }
            if (text[0] === "`") {
              const end = line.text.indexOf(text, tokens.lastIndex);
              if (end >= 0) tokens.lastIndex = end + text.length;
              continue;
            }
            const tag = /^<(\/?)(\w+)/.exec(text);
            if (!tag) continue;
            const name = tag[2].toLowerCase();
            if (name !== "details") {
              if (!tag[1]) rawTag = name;
            } else if (!tag[1]) depth++;
            else if (--depth === 0) break;
          }
        }
        const to = context.lineStart + line.text.length;
        const more = context.nextLine();
        if (depth === 0 || !more) {
          context.addElement(context.elt("HTMLBlock", from, to));
          return true;
        }
      } while (true);
    },
  }],
};
