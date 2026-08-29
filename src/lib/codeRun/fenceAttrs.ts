// Fence attributes: the `{…}` suffix on a code block's info string.
//
//     ```python {in=loan, out=table, watch}
//
// The language id stays in first position, so `fenceLang` — and with it the
// whole runner-matching path — keeps working unchanged on a block that carries
// attributes. Everything here is deliberately forgiving: an attribute nobody
// recognises, or a `{` that never closes, leaves a plain code block behind
// rather than breaking the note.

/** How a run's output is rendered. `text` is the classic output-panel path. */
export type OutKind =
  | "text"
  | "table"
  | "json"
  | "mermaid"
  | "html"
  | "image"
  | "markdown";

const OUT_KINDS = new Set<OutKind>([
  "text",
  "table",
  "json",
  "mermaid",
  "html",
  "image",
  "markdown",
]);

export const isOutKind = (value: string): value is OutKind =>
  OUT_KINDS.has(value as OutKind);

/** Where a block's inputs come from: another ```input block, a markdown table
 *  in the same note, or a file on disk. */
export interface InputBinding {
  kind: "block" | "table" | "file";
  /** Block id, table name or file path, depending on `kind`. */
  name: string;
}

/**
 * What makes a block run on its own.
 *
 * `manual` is the default and the only one that never surprises anyone: the
 * block runs when its 运行 button is clicked. `watch` recomputes after a control
 * moves — still a user gesture. `open` runs when the note is opened, which is
 * the only trigger with no gesture behind it at all.
 */
export type RunTrigger = "manual" | "watch" | "open";

/** Which side of the code block the rendered result sits on. */
export type ResultPlacement = "above" | "below";

export interface FenceAttrs {
  /** `id=…` — names an ```input block so code blocks can bind to it. */
  id: string | null;
  /** `in=…` */
  input: InputBinding | null;
  out: OutKind;
  /** Whether `out=` was written down; a bare block stays on the text path. */
  outExplicit: boolean;
  /** `run=watch|open`, or the bare `watch` flag. */
  trigger: RunTrigger;
  /** `inline` — render the result in the document. Implied by a rich `out=`. */
  inline: boolean;
  /** `result=above|below`. Above by default: the result is what you are reading
   *  the note for, and the code that produced it is the footnote. */
  placement: ResultPlacement;
}

export interface FenceInfo {
  /** Lowercased language id, `""` when the fence has no info string. */
  lang: string;
  attrs: FenceAttrs;
}

const emptyAttrs = (): FenceAttrs => ({
  id: null,
  input: null,
  out: "text",
  outExplicit: false,
  trigger: "manual",
  inline: false,
  placement: "above",
});

const IDENT = /^[A-Za-z_][A-Za-z0-9_-]*$/;

function parseBinding(value: string): InputBinding | null {
  const colon = value.indexOf(":");
  if (colon < 0) return value ? { kind: "block", name: value } : null;
  const kind = value.slice(0, colon).trim().toLowerCase();
  const name = value.slice(colon + 1).trim();
  if (!name) return null;
  if (kind === "table") return { kind: "table", name };
  if (kind === "file") return { kind: "file", name };
  return null;
}

/**
 * Split an info string into its language and attributes.
 *
 * Attributes are comma-separated so a value may contain spaces
 * (`in=table:销售 数据`); each is `key=value` or a bare flag.
 */
export function parseFenceInfo(info: string): FenceInfo {
  const brace = info.indexOf("{");
  const head = brace < 0 ? info : info.slice(0, brace);
  const lang = head.trim().toLowerCase().split(/\s+/)[0] ?? "";
  const attrs = emptyAttrs();
  if (brace < 0) return { lang, attrs };

  const close = info.lastIndexOf("}");
  if (close < brace) return { lang, attrs }; // unterminated — ignore the rest
  const body = info.slice(brace + 1, close);

  for (const raw of body.split(",")) {
    const entry = raw.trim();
    if (!entry) continue;
    const eq = entry.indexOf("=");
    if (eq < 0) {
      const flag = entry.toLowerCase();
      if (flag === "watch") attrs.trigger = "watch";
      else if (flag === "inline") attrs.inline = true;
      continue;
    }
    const key = entry.slice(0, eq).trim().toLowerCase();
    const value = entry.slice(eq + 1).trim();
    switch (key) {
      case "id":
        if (IDENT.test(value)) attrs.id = value;
        break;
      case "in":
        attrs.input = parseBinding(value);
        break;
      case "out": {
        const kind = value.toLowerCase();
        if (isOutKind(kind)) {
          attrs.out = kind;
          attrs.outExplicit = true;
        }
        break;
      }
      case "watch":
        attrs.trigger = value === "false" ? "manual" : "watch";
        break;
      case "run":
        if (value === "watch" || value === "open" || value === "manual")
          attrs.trigger = value;
        break;
      case "inline":
        // `inline=below` is the shorthand people reach for; it means the same
        // as writing `inline, result=below`.
        attrs.inline = value !== "false";
        if (value === "below" || value === "above") attrs.placement = value;
        break;
      case "result":
        if (value === "below" || value === "above") attrs.placement = value;
        break;
    }
  }
  return { lang, attrs };
}

/** Whether the result should render in the document instead of only in the
 *  output panel. A rich `out=` implies it: nobody asks for a chart and wants
 *  it in a side panel. */
export const rendersInline = (attrs: FenceAttrs): boolean =>
  attrs.inline || (attrs.outExplicit && attrs.out !== "text");

/** An opening fence line's info string, or null when the line isn't one. */
export function fenceInfoOf(text: string): string | null {
  const m = text.match(/^\s*(?:`{3,}|~{3,})(.*)$/);
  return m ? m[1] : null;
}

/** A closing fence line (only fence characters, nothing after). */
export const isCloseFenceLine = (text: string): boolean =>
  /^\s*(?:`{3,}|~{3,})\s*$/.test(text);

/** ```input opening fence, with or without attributes. */
export const INPUT_FENCE = /^\s*(?:`{3,}|~{3,})\s*input\s*(?:\{|$)/i;

/**
 * A run's output may pick its own renderer with a `::out <kind>` first line.
 * Returns the kind found (falling back to `fallback`) and the body without it.
 */
export function parseOutDirective(
  text: string,
  fallback: OutKind,
): { kind: OutKind; body: string } {
  const m = text.match(/^[ \t]*::out[ \t]+([a-z]+)[ \t]*\r?\n?/i);
  if (!m) return { kind: fallback, body: text };
  const kind = m[1].toLowerCase();
  if (!isOutKind(kind)) return { kind: fallback, body: text };
  return { kind, body: text.slice(m[0].length) };
}
