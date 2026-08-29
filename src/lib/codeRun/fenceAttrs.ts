// Fence attributes: the `{…}` suffix on a code block's info string.
//
//     ```python {in=loan, out=table, watch}
//
// The language id stays in first position, so `fenceLang` — and with it the
// whole runner-matching path — keeps working unchanged on a block that carries
// attributes. Everything here is deliberately forgiving: an attribute nobody
// recognises, or a `{` that never closes, leaves a plain code block behind
// rather than breaking the note.

/** Component types supported by the stdout JSON protocol. */
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
  /** Whether a concrete `out=<type>` was written down; otherwise stdout must
   *  self-describe. */
  outExplicit: boolean;
  /** `out=auto` — the fence promises a self-describing `idea_note_result`
   *  envelope without naming the type up front, so the script can choose it at
   *  run time. Like a bare fence for parsing, like an explicit `out=` for the
   *  note: the result has a home in the document, so no panel pops open. */
  outAuto: boolean;
  /** `run=watch|open`, or the bare `watch` flag. */
  trigger: RunTrigger;
  /** All automatic triggers written on the fence. Kept separately from
   *  `trigger` so older callers that expect one value remain compatible. */
  triggers: RunTrigger[];
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
  outAuto: false,
  trigger: "manual",
  triggers: [],
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

  const addTrigger = (trigger: RunTrigger) => {
    if (trigger === "manual") {
      attrs.triggers = [];
      attrs.trigger = "manual";
      return;
    }
    if (!attrs.triggers.includes(trigger)) attrs.triggers.push(trigger);
    attrs.trigger = trigger;
  };

  const removeTrigger = (trigger: RunTrigger) => {
    attrs.triggers = attrs.triggers.filter((item) => item !== trigger);
    attrs.trigger = attrs.triggers[attrs.triggers.length - 1] ?? "manual";
  };

  for (const raw of body.split(",")) {
    const entry = raw.trim();
    if (!entry) continue;
    const eq = entry.indexOf("=");
    if (eq < 0) {
      const flag = entry.toLowerCase();
      if (flag === "watch") addTrigger("watch");
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
        // Written twice, the last one wins — so each branch clears the other.
        if (kind === "auto") {
          attrs.outAuto = true;
          attrs.outExplicit = false;
        } else if (isOutKind(kind)) {
          attrs.out = kind;
          attrs.outExplicit = true;
          attrs.outAuto = false;
        }
        break;
      }
      case "watch":
        if (value === "false") removeTrigger("watch");
        else addTrigger("watch");
        break;
      case "run": {
        const triggers = value.toLowerCase().split(/[+|\s]+/);
        for (const trigger of triggers) {
          if (trigger === "manual" || trigger === "watch" || trigger === "open")
            addTrigger(trigger);
        }
        break;
      }
      case "result":
        if (value === "below" || value === "above") attrs.placement = value;
        break;
    }
  }
  return { lang, attrs };
}

export interface FenceMarker {
  char: "`" | "~";
  length: number;
  info: string;
}

/** A Markdown opening fence, including the delimiter needed to find its close. */
export function openingFenceOf(text: string): FenceMarker | null {
  const m = text.match(/^\s*(`{3,}|~{3,})(.*)$/);
  if (!m) return null;
  return {
    char: m[1][0] as FenceMarker["char"],
    length: m[1].length,
    info: m[2],
  };
}

/** Whether a line closes this specific fence (same character, no shorter). */
export function isCloseFenceFor(text: string, opening: FenceMarker): boolean {
  const marker = text.trim();
  if (marker.length < opening.length) return false;
  for (const char of marker) if (char !== opening.char) return false;
  return true;
}

/** An opening fence line's info string, or null when the line isn't one. */
export function fenceInfoOf(text: string): string | null {
  return openingFenceOf(text)?.info ?? null;
}

/** A closing fence line (only fence characters, nothing after). */
export const isCloseFenceLine = (text: string): boolean =>
  /^\s*(?:`{3,}|~{3,})\s*$/.test(text);

/** ```input opening fence, with or without attributes. */
export const INPUT_FENCE = /^\s*(?:`{3,}|~{3,})\s*input\s*(?:\{|$)/i;
