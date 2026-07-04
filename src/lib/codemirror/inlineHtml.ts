// Inline markdown + raw HTML rendering, shared by the table and HTML block/
// paragraph widgets. CodeMirror's decoration-based live preview can't reach the
// isolated DOM inside a WidgetType, so these widgets render their own content:
// we turn the small subset of inline markdown we support into an HTML string,
// pass any raw HTML through untouched, then run the whole thing through
// DOMPurify before it ever touches innerHTML.

import DOMPurify from "dompurify";

import { toDisplaySrc } from "../imagePath";

/** Escape text so it renders literally (not as markup), but keep valid HTML
 *  entities (`&copy;`, `&amp;`, `&#169;`, `&#xA9;`) intact so they still decode. */
function escText(s: string): string {
  return s
    .replace(/&(?![a-zA-Z][a-zA-Z0-9]*;|#\d+;|#[xX][0-9a-fA-F]+;)/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Escape a string for use inside a double-quoted attribute. */
function escAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** Is `ch` a word character? Used to keep `_` from triggering inside snake_case. */
function isWord(ch: string | undefined): boolean {
  return !!ch && /[\p{L}\p{N}_]/u.test(ch);
}

// A single HTML tag (`<b>`, `</b>`, `<br/>`, `<span style="…">`) or an HTML
// comment. Sticky so it can be anchored at an arbitrary offset without slicing.
const HTML_TAG =
  /<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^<>]*?)?\/?>|<!--[\s\S]*?-->/y;

type Emphasis = { marker: string; tag: "strong" | "em" | "del"; cls: string };

/** Match an emphasis opener at `i`, longest marker first (`***` > `**` > `*`). */
function emphasisAt(text: string, i: number): Emphasis | null {
  if (text.startsWith("***", i) || text.startsWith("___", i))
    return { marker: text.slice(i, i + 3), tag: "strong", cls: "cm-md-strong" };
  if (text.startsWith("**", i) || text.startsWith("__", i))
    return { marker: text.slice(i, i + 2), tag: "strong", cls: "cm-md-strong" };
  if (text.startsWith("~~", i))
    return { marker: "~~", tag: "del", cls: "cm-md-strike" };
  const c = text[i];
  if (c === "*" || c === "_") return { marker: c, tag: "em", cls: "cm-md-em" };
  return null;
}

/**
 * Find the closing `marker` for an emphasis opened at `start`. Skips escaped
 * markers and, for `_`-style markers, ones that sit inside a word. Returns -1
 * if unclosed.
 */
function findClose(text: string, marker: string, start: number): number {
  const underscore = marker[0] === "_";
  let s = start;
  while (s < text.length) {
    const at = text.indexOf(marker, s);
    if (at < 0) return -1;
    const okClose = !underscore || !isWord(text[at + marker.length]);
    if (at > start && okClose && text[at - 1] !== "\\") return at;
    s = at + 1;
  }
  return -1;
}

/** Match a `[label](url)` link at `i`; returns the label, url and end offset. */
function linkAt(
  text: string,
  i: number,
): { label: string; url: string; end: number } | null {
  if (text[i] !== "[") return null;
  const close = text.indexOf("]", i + 1);
  if (close < 0 || text[close + 1] !== "(") return null;
  const paren = text.indexOf(")", close + 2);
  if (paren < 0) return null;
  return {
    label: text.slice(i + 1, close),
    url: text.slice(close + 2, paren).trim(),
    end: paren + 1,
  };
}

/** Match an image `![alt](url)` or a linked-image badge `[![alt](url)](link)`
 *  at `i`. Returns the image's alt + url (the link wrapper is dropped) and end
 *  offset. Must be tried before {@link linkAt}, whose greedy `]`/`)` scan would
 *  otherwise grab `[![alt](url)` as a plain link. */
function imageAt(text: string, i: number): { alt: string; url: string; end: number } | null {
  const rest = text.slice(i);
  let m = /^\[!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(rest);
  if (m) return { alt: m[1], url: m[2], end: i + m[0].length };
  m = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(rest);
  if (m) return { alt: m[1], url: m[2], end: i + m[0].length };
  return null;
}

/**
 * Render inline markdown (bold/italic/strike/code/links + `\` escapes) to an
 * HTML string, passing raw HTML tags through verbatim. Plain text is escaped so
 * stray `<`/`&` stay literal. The result still needs {@link sanitizeHtml} before
 * being inserted into the DOM.
 */
export function renderInlineHtml(text: string): string {
  let out = "";
  let buf = "";
  const flush = () => {
    out += escText(buf);
    buf = "";
  };
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];

    // `\*` -> `*`: keep the escaped char literally.
    if (c === "\\" && i + 1 < n) {
      buf += text[i + 1];
      i += 2;
      continue;
    }

    // Raw HTML tag/comment: pass through untouched (sanitized later).
    if (c === "<") {
      HTML_TAG.lastIndex = i;
      const tag = HTML_TAG.exec(text);
      if (tag) {
        flush();
        out += tag[0];
        i += tag[0].length;
        continue;
      }
    }

    // Inline code: `...` — verbatim, no formatting inside.
    if (c === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i + 1) {
        flush();
        out += `<code class="cm-md-code">${escText(text.slice(i + 1, end))}</code>`;
        i = end + 1;
        continue;
      }
    }

    // Images / linked-image badges: render as <img>. Checked before links so
    // the greedy linkAt doesn't grab `[![alt](url)` as a plain link.
    if (c === "!" || c === "[") {
      const image = imageAt(text, i);
      if (image) {
        flush();
        out += `<img class="cm-md-inline-img" src="${escAttr(toDisplaySrc(image.url))}" alt="${escAttr(image.alt)}" loading="lazy" />`;
        i = image.end;
        continue;
      }
    }

    // Links: render the label styled blue (URL kept as a title tooltip;
    // data-href powers Cmd/Ctrl+click in widget-rendered cells, linkClick.ts).
    const link = linkAt(text, i);
    if (link) {
      flush();
      const title = link.url
        ? ` title="${escAttr(link.url)}" data-href="${escAttr(link.url)}"`
        : "";
      out += `<span class="cm-md-link"${title}>${renderInlineHtml(link.label)}</span>`;
      i = link.end;
      continue;
    }

    // Emphasis / strong / strikethrough (incl. `***` bold+italic).
    const emph = emphasisAt(text, i);
    const okOpen = !emph || emph.marker[0] !== "_" || !isWord(text[i - 1]);
    if (emph && okOpen) {
      const start = i + emph.marker.length;
      const close = findClose(text, emph.marker, start);
      if (close > start) {
        flush();
        const inner = renderInlineHtml(text.slice(start, close));
        out +=
          emph.marker.length === 3
            ? `<strong class="cm-md-strong"><em class="cm-md-em">${inner}</em></strong>`
            : `<${emph.tag} class="${emph.cls}">${inner}</${emph.tag}>`;
        i = close + emph.marker.length;
        continue;
      }
    }

    buf += c;
    i += 1;
  }
  flush();
  return out;
}

/** Does `text` contain an inline HTML tag/comment or an HTML entity? Such a
 *  paragraph needs the HTML renderer rather than the plain live preview. */
export function hasInlineHtml(text: string): boolean {
  return /<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^<>]*?)?\/?>|<!--|&(?:[a-zA-Z][a-zA-Z0-9]*|#\d+|#[xX][0-9a-fA-F]+);/.test(
    text,
  );
}

/**
 * Sanitize an HTML string for safe insertion via innerHTML: strips `<script>`,
 * inline event handlers, `javascript:` URLs, etc., while keeping the common
 * formatting tags/attributes used in notes (style, color, align, …).
 */
export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true, svg: true, svgFilters: true },
    ADD_ATTR: ["target", "align", "color", "face"],
  });
}
