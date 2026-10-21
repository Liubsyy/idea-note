// Shared helpers for the toolbar's colour tools, which express text/background
// colour as `<span style="color: #rrggbb">…</span>` — the form every markdown
// renderer understands (the editor's own htmlPreview, the PDF export, and other
// editors the note may be opened in).
//
// The markdown syntax tree parses `<span …>` as a bare HTMLTag with no attribute
// detail, so finding the span around the cursor means scanning the line's text.
// Regexes here stay simple and anchored — no lookbehind, no named groups — for
// the macOS 12 WKWebView.

import type { EditorState } from "@codemirror/state";

export interface SpanMatch {
  /** Absolute offsets of the `<span …>` open tag. */
  openFrom: number;
  openTo: number;
  /** Absolute offsets of the matching `</span>`. */
  closeFrom: number;
  closeTo: number;
  /** Parsed `style` attribute of the open tag (empty when it has none). */
  style: Map<string, string>;
}

/** A `<span …>` open tag (attributes captured) or a `</span>` close tag. */
const SPAN_TAG = /<span\b([^>]*)>|<\/span\s*>/gi;
const STYLE_ATTR = /style\s*=\s*"([^"]*)"/i;

/** Parse a `style` attribute value into an ordered property map. */
export function parseStyle(style: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of style.split(";")) {
    const i = part.indexOf(":");
    if (i < 0) continue;
    const key = part.slice(0, i).trim().toLowerCase();
    const value = part.slice(i + 1).trim();
    if (key && value) map.set(key, value);
  }
  return map;
}

/** Serialize a property map back into a `style` attribute value. */
export function serializeStyle(style: Map<string, string>): string {
  return Array.from(style, ([k, v]) => `${k}: ${v}`).join("; ");
}

/**
 * Every `<span>…</span>` pair on one line, innermost first.
 *
 * Single-line only: a span opened on one line and closed on another is ignored,
 * which matches the colour tools' scope — they wrap each line separately rather
 * than straddling the blank lines and table rows between blocks.
 */
function spanPairsOnLine(state: EditorState, lineNumber: number): SpanMatch[] {
  const line = state.doc.line(lineNumber);
  const pairs: SpanMatch[] = [];
  // Walk the line's tags keeping a stack of open ones; each close pops the
  // innermost still-open tag, so pairs come out innermost first.
  const open: { from: number; to: number; attrs: string }[] = [];
  SPAN_TAG.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SPAN_TAG.exec(line.text))) {
    const tagFrom = line.from + m.index;
    const tagTo = tagFrom + m[0].length;
    if (m[1] !== undefined) {
      open.push({ from: tagFrom, to: tagTo, attrs: m[1] });
      continue;
    }
    const start = open.pop();
    if (!start) continue;
    const attr = STYLE_ATTR.exec(start.attrs);
    pairs.push({
      openFrom: start.from,
      openTo: start.to,
      closeFrom: tagFrom,
      closeTo: tagTo,
      style: parseStyle(attr ? attr[1] : ""),
    });
  }
  return pairs;
}

/**
 * The innermost span enclosing [from, to], if any. The tags count as part of it:
 * once a span's source is revealed for editing the cursor often sits inside
 * `<span style="…">` itself, and from there recolouring has to act on that span
 * — not insert a new one into the middle of its markup.
 */
export function findSpanAt(
  state: EditorState,
  from: number,
  to: number,
): SpanMatch | null {
  const line = state.doc.lineAt(from);
  if (to > line.to) return null;
  return (
    spanPairsOnLine(state, line.number).find(
      (s) => s.openFrom <= from && to <= s.closeTo,
    ) ?? null
  );
}

/**
 * Every span on the selected lines that overlaps [from, to], in document order
 * — including ones that merely enclose part of it, since a selection normally
 * shows only the text between a span's tags, not the tags themselves.
 */
export function findSpansIn(
  state: EditorState,
  from: number,
  to: number,
): SpanMatch[] {
  const spans: SpanMatch[] = [];
  const last = state.doc.lineAt(to).number;
  for (let n = state.doc.lineAt(from).number; n <= last; n++)
    for (const span of spanPairsOnLine(state, n))
      if (span.openFrom < to && span.closeTo > from) spans.push(span);
  return spans.sort((a, b) => a.openFrom - b.openFrom);
}
