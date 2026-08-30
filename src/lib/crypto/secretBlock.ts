// Parsing and serialising ```secret blocks.
//
//     ```secret {v=1, key=k1, id=b9f3a2c}
//     <base64url(nonce ‖ ciphertext ‖ tag), wrapped at 96 columns>
//     ```
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

/** A fresh block id: a letter (IDENT requires one) plus 3 random bytes. */
export function newBlockId(): string {
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  return `b${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Every secret block in the document, in order.
 *
 * The fence walk mirrors `scanInputBlocks`: it steps over *every* fenced block,
 * not just the ones it wants, so a ```secret written inside a documentation
 * fence isn't mistaken for a real one.
 */
export function scanSecretBlocks(doc: DocLike): SecretBlockInfo[] {
  const blocks: SecretBlockInfo[] = [];
  let i = 1;
  while (i <= doc.lines) {
    const line = doc.line(i);
    const opening: FenceMarker | null = openingFenceOf(line.text);
    if (!opening) {
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
    blocks.push({
      from: line.from,
      to: doc.line(closeLine).to,
      meta: parseSecretAttrs(opening.info),
      body: hasBody ? doc.sliceString(bodyFrom, bodyTo) : "",
      bodyFrom,
      bodyTo,
    });
    i = closeLine + 1;
  }
  return blocks;
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
