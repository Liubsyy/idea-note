// Parsing and serialising secret content, in both of its shapes.
//
//     ```secret {v=1, key=k1, id=b9f3a2c}
//     <base64url(nonce ‖ ciphertext ‖ tag), wrapped at 96 columns>
//     ```
//
//     …and inline: `secret {v=1, key=k1, id=b7c1f2a} <base64url, one line>`
//
// The two shapes share everything that matters — the attributes, the AAD, the
// payload — and differ only in how they sit in the text. That is deliberate:
// the same ciphertext decrypts in either shape, so moving one to the other is
// a text edit rather than a re-encryption.
//
// Everything here is pure so it can be tested without CodeMirror or Tauri.
//
// Two rules shape this file:
//
//   1. The AAD is rebuilt from *parsed* values (see `canonicalAad`), never from
//      the fence line's text. `{v=1,key=k1}` and `{ v = 1 , key = k1 }` are the
//      same block; authenticating the literal characters would let one stray
//      space lock a block forever.
//
//   2. Failure is always a downgrade, never an exception and never an edit. An
//      unreadable block renders as an ordinary code block and its bytes are
//      left exactly as they were — a note is not worth losing to a parser
//      disagreement.

import {
  isCloseFenceFor,
  openingFenceOf,
  type FenceMarker,
} from "../codeRun/fenceAttrs.ts";

/** Columns the ciphertext is wrapped at. Line-level diffs keep a git conflict
 *  on an encrypted block down to "pick a side" instead of producing a spliced,
 *  undecryptable body. */
export const BODY_WRAP_COLUMNS = 96;

/** Same rule the fence-attribute parser already enforces for `id=`, which is
 *  why a block id has to start with a letter — a bare hex id like `9f3a2c`
 *  would be rejected. */
const IDENT = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** The three fields covered by the AAD. Anything else on the fence line is
 *  carried through untouched but is NOT authenticated. */
export interface SecretMeta {
  v: number;
  keyId: string;
  id: string;
  /** Unrecognised `key=value` attributes, kept verbatim and in order so
   *  re-encrypting a block never silently drops one written by a newer build.
   *  Not authenticated: these can be altered without failing the tag check. */
  extras: string[];
}

/** Which of the two shapes a piece of secret content is written in. */
export type SecretKind = "block" | "inline";

export interface SecretBlockInfo {
  /** Whole block, both fence lines included. */
  from: number;
  to: number;
  /** Null when the fence could not be understood — render it as a plain code
   *  block and leave it alone. */
  meta: SecretMeta | null;
  /** Body text as written, wrapping included. */
  body: string;
  bodyFrom: number;
  bodyTo: number;
}

/** A block or an inline span. The extra field is what tells the renderers and
 *  the flush path which serialiser to use on the way back out. */
export interface SecretInfo extends SecretBlockInfo {
  kind: SecretKind;
}

/** The subset of CodeMirror's `Text` this module needs. Declared structurally
 *  so tests can hand in a plain object instead of pulling in the editor. */
export interface DocLike {
  readonly lines: number;
  line(n: number): { from: number; to: number; text: string };
  sliceString(from: number, to: number): string;
}

/** Opening fence of a secret block, with or without attributes. */
export const SECRET_FENCE = /^\s*(?:`{3,}|~{3,})\s*secret\s*(?:\{|$)/i;

const isSecretInfo = (info: string): boolean =>
  /^\s*secret\s*(?:\{|$)/i.test(info);

/**
 * Read the `{…}` attributes off a secret fence's info string.
 *
 * Strict where it counts and forgiving where it doesn't: `v`, `key` and `id`
 * must each appear exactly once and be well-formed, because they go into the
 * AAD; unknown attributes are preserved rather than rejected, so a block
 * written by a newer build still round-trips through this one intact.
 */
export function parseSecretAttrs(info: string): SecretMeta | null {
  if (!isSecretInfo(info)) return null;
  const open = info.indexOf("{");
  if (open < 0) return null;
  const close = info.lastIndexOf("}");
  if (close < open) return null; // unterminated
  if (info.slice(close + 1).trim() !== "") return null; // trailing junk

  let v: number | null = null;
  let keyId: string | null = null;
  let id: string | null = null;
  const extras: string[] = [];

  for (const raw of info.slice(open + 1, close).split(",")) {
    const entry = raw.trim();
    if (!entry) continue;
    const eq = entry.indexOf("=");
    if (eq < 0) return null; // bare flags mean nothing here
    const name = entry.slice(0, eq).trim().toLowerCase();
    const value = entry.slice(eq + 1).trim();
    switch (name) {
      case "v": {
        if (v !== null) return null; // duplicate
        if (!/^\d+$/.test(value)) return null;
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed) || parsed < 1) return null;
        v = parsed;
        break;
      }
      case "key":
        if (keyId !== null || !IDENT.test(value)) return null;
        keyId = value;
        break;
      case "id":
        if (id !== null || !IDENT.test(value)) return null;
        id = value;
        break;
      default:
        extras.push(entry);
    }
  }
  if (v === null || keyId === null || id === null) return null;
  return { v, keyId, id, extras };
}

/** The info string for a block — `secret {v=1, key=k1, id=b9f3a2c}`. */
export function formatSecretAttrs(meta: SecretMeta): string {
  const parts = [`v=${meta.v}`, `key=${meta.keyId}`, `id=${meta.id}`, ...meta.extras];
  return `secret {${parts.join(", ")}}`;
}

/**
 * The AAD a block's ciphertext is bound to, in canonical form: fixed order,
 * fixed separator, no spaces, and only the three authenticated fields.
 *
 * Mirrors `block_aad` in src-tauri/src/crypto.rs — the Rust side builds its own
 * copy from the same values, so this exists for tests and for keeping the two
 * definitions visibly in sync. Change one and you must change the other, or
 * every existing block stops decrypting.
 */
export const canonicalAad = (meta: SecretMeta): string =>
  `v=${meta.v}|key=${meta.keyId}|id=${meta.id}`;

/** Break ciphertext into fixed-width lines. */
export function wrapBody(body: string, columns = BODY_WRAP_COLUMNS): string {
  const compact = body.replace(/\s+/g, "");
  if (compact.length <= columns) return compact;
  const lines: string[] = [];
  for (let i = 0; i < compact.length; i += columns) {
    lines.push(compact.slice(i, i + columns));
  }
  return lines.join("\n");
}

/** A complete fenced block, ready to splice into a document. */
export function formatSecretBlock(meta: SecretMeta, body: string): string {
  return `\`\`\`${formatSecretAttrs(meta)}\n${wrapBody(body)}\n\`\`\``;
}

/**
 * A complete inline span, ready to splice into a document.
 *
 * Deliberately unwrapped. An inline replace decoration may not cross a line
 * break, and the 96-column wrapping exists for Git's line-level diff on a
 * fenced block — an inline span has neither need.
 */
export function formatInlineSecret(meta: SecretMeta, body: string): string {
  return `\`${formatSecretAttrs(meta)} ${body.replace(/\s+/g, "")}\``;
}

/** A fresh block id: a letter (IDENT requires one) plus 8 random bytes. */
export function newBlockId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `b${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * One inline secret span: `secret {v=1, key=k1, id=b7c1f2a} sT3n…`.
 *
 * The body alphabet is base64url without padding, which contains no backtick,
 * so the ciphertext can never cut its own span short. The attribute part
 * excludes backticks and braces for the same reason.
 */
const INLINE_SECRET = /`secret[ \t]*\{[^`{}\n]*\}[ \t]*([A-Za-z0-9_-]+)`/g;

/** The inline spans on one line, at absolute document offsets. */
function scanInlineOnLine(text: string, offset: number): SecretInfo[] {
  const found: SecretInfo[] = [];
  INLINE_SECRET.lastIndex = 0;
  for (let m = INLINE_SECRET.exec(text); m; m = INLINE_SECRET.exec(text)) {
    const start = m.index;
    const end = start + m[0].length;
    // A ``…`` code span is delimited by two backticks; the run matched here is
    // one, so a backtick on either side means this is a slice of something
    // larger rather than a secret of its own.
    if (text[start - 1] === "`" || text[end] === "`") continue;
    // Everything up to and including the closing brace is exactly the info
    // string `parseSecretAttrs` already understands — one parser, one AAD.
    const meta = parseSecretAttrs(m[0].slice(1, m[0].lastIndexOf("}") + 1));
    // Unparseable attributes fall through to the ordinary inline-code
    // rendering, so the user can see and repair the raw text.
    if (!meta) continue;
    const bodyFrom = offset + end - 1 - m[1].length;
    found.push({
      kind: "inline",
      from: offset + start,
      to: offset + end,
      meta,
      body: m[1],
      bodyFrom,
      bodyTo: bodyFrom + m[1].length,
    });
  }
  return found;
}

/**
 * Replace every inline secret in a run of text with a placeholder.
 *
 * For the read-only paths that show note text somewhere other than the editor —
 * the outline, for one. They cannot decrypt and have no business trying; what
 * they must not do is print a wall of base64 where a phrase used to be.
 *
 * Fence awareness is the caller's, same as it is for the outline scanner: this
 * sees the text it is handed and nothing about where it came from.
 */
export function redactInlineSecrets(text: string, placeholder = "🔒"): string {
  const spans = scanInlineOnLine(text, 0);
  if (spans.length === 0) return text;
  let out = "";
  let at = 0;
  for (const span of spans) {
    out += text.slice(at, span.from) + placeholder;
    at = span.to;
  }
  return out + text.slice(at);
}

/**
 * Whether an entire inline code span — backticks included — is a secret.
 *
 * livePreview.ts asks this so it can leave such a span's markers and styling
 * alone: the span is replaced whole by the secret renderer, and two replace
 * decorations over the same characters is not a defined thing.
 */
export function isInlineSecret(source: string): boolean {
  const [span] = scanInlineOnLine(source, 0);
  return span !== undefined && span.from === 0 && span.to === source.length;
}

/**
 * Every secret in the document, both shapes, in order.
 *
 * The fence walk mirrors `scanInputBlocks`: it steps over *every* fenced block,
 * not just the ones it wants, so a ```secret written inside a documentation
 * fence isn't mistaken for a real one. Inline spans ride on the same walk and
 * get the same protection for free — a line inside any fence is never visited
 * by the inline scan, so an example written in a code block stays an example.
 */
export function scanSecrets(doc: DocLike): SecretInfo[] {
  const found: SecretInfo[] = [];
  let i = 1;
  while (i <= doc.lines) {
    const line = doc.line(i);
    const opening: FenceMarker | null = openingFenceOf(line.text);
    if (!opening) {
      found.push(...scanInlineOnLine(line.text, line.from));
      i++;
      continue;
    }
    let j = i + 1;
    while (j <= doc.lines && !isCloseFenceFor(doc.line(j).text, opening)) j++;
    const closeLine = Math.min(j, doc.lines);
    if (!isSecretInfo(opening.info)) {
      i = closeLine + 1;
      continue;
    }
    const hasBody = j > i + 1;
    const bodyFrom = hasBody ? doc.line(i + 1).from : line.to;
    const bodyTo = hasBody ? doc.line(j - 1).to : line.to;
    found.push({
      kind: "block",
      from: line.from,
      to: doc.line(closeLine).to,
      meta: parseSecretAttrs(opening.info),
      body: hasBody ? doc.sliceString(bodyFrom, bodyTo) : "",
      bodyFrom,
      bodyTo,
    });
    i = closeLine + 1;
  }
  return found;
}

/** Just the fenced blocks, for the callers that only ever deal in those. */
export function scanSecretBlocks(doc: DocLike): SecretBlockInfo[] {
  return scanSecrets(doc).filter((s) => s.kind === "block");
}

/** Build a `DocLike` from a plain string — used by tests and by any caller
 *  holding note text rather than an editor document. */
export function docFromString(text: string): DocLike {
  const raw = text.split("\n");
  const starts: number[] = [];
  let offset = 0;
  for (const line of raw) {
    starts.push(offset);
    offset += line.length + 1;
  }
  return {
    lines: raw.length,
    line(n: number) {
      const index = n - 1;
      return { from: starts[index], to: starts[index] + raw[index].length, text: raw[index] };
    },
    sliceString(from: number, to: number) {
      return text.slice(from, to);
    },
  };
}
