// The two shapes an image takes in a note, shared by the live preview, the
// inline (table / HTML) renderer, the print pipeline and the toolbar's image
// dialog so all four agree.
//
//   no size → `![alt](<a.png>)`, plain CommonMark, what paste and the
//             attachment path produce
//   sized   → `<img src="a.png" width="90%">`, the one form every markdown
//             renderer honours (GitHub included)
//
// `![](<a.png> =300x200)` — the Typora / markdown-it-imsize form — is still
// *read* so notes written elsewhere (or by earlier versions of this app) keep
// rendering, but it is never written: it is not valid CommonMark, so a strict
// renderer drops the image and prints the source text instead. Lezer and
// markdown-it both bail on it, falling back to the hand-rolled recovery each
// already has for spaced paths; those call parseImageDest to split the size off.

/** Explicit width / height. Bare digits mean px, `%` is kept; "" = auto. */
export interface ImageSize {
  width: string;
  height: string;
}

export const NO_IMAGE_SIZE: ImageSize = { width: "", height: "" };

/** One dimension: `300`, `12.5`, `50%`. */
const DIM = String.raw`\d+(?:\.\d+)?%?`;
/** Trailing ` =300x200` / ` =300x` / ` =300` / ` =x200` on a destination. */
const SIZE_RE = new RegExp(
  String.raw`\s+=\s*(?:(${DIM})(?:x(${DIM})?)?|x(${DIM}))$`,
);
/** Trailing CommonMark link title: `"…"`, `'…'` or `(…)`. */
const TITLE_RE = /\s+(?:"([^"]*)"|'([^']*)'|\(([^()]*)\))$/;

export function hasImageSize(size: ImageSize): boolean {
  return size.width !== "" || size.height !== "";
}

/**
 * Split the text between an image's parens into its path, size and title.
 * The size and the title are accepted in either order — other editors put the
 * title last, this app writes the size last — and the returned `dest` keeps any
 * `<…>` wrapper, which {@link toDisplaySrc} strips when loading the file.
 */
export function parseImageDest(inner: string): {
  dest: string;
  size: ImageSize;
  title: string;
} {
  let dest = inner.trim();
  const size: ImageSize = { ...NO_IMAGE_SIZE };
  let title = "";
  // Two passes so `<a.png> =300x "cap"` and `<a.png> "cap" =300x` both resolve.
  for (let i = 0; i < 2; i++) {
    const t = TITLE_RE.exec(dest);
    if (t && !title) {
      title = t[1] ?? t[2] ?? t[3] ?? "";
      dest = dest.slice(0, t.index);
      continue;
    }
    const s = SIZE_RE.exec(dest);
    if (s && !hasImageSize(size)) {
      size.width = s[1] ?? "";
      size.height = s[2] ?? s[3] ?? "";
      dest = dest.slice(0, s.index);
      continue;
    }
    break;
  }
  return { dest: dest.trim(), size, title };
}

/** Inverse of {@link parseImageDest} minus the size, which is never written
 *  back into a destination; `dest` is used as written. */
export function buildImageDest(dest: string, title: string): string {
  let out = dest;
  if (title) {
    // A title holding a double quote is written with single quotes instead;
    // CommonMark has no escape that every renderer honours.
    const quote = title.includes('"') ? "'" : '"';
    out += ` ${quote}${title.replace(new RegExp(quote, "g"), "")}${quote}`;
  }
  return out;
}

/** Strip a `<…>` wrapper, leaving the path itself. */
export function unwrapImageDest(dest: string): string {
  const s = dest.trim();
  return s.startsWith("<") && s.endsWith(">") ? s.slice(1, -1) : s;
}

/**
 * Wrap a path in `<…>`, CommonMark's explicit destination form. Required when
 * the path contains spaces, and used unconditionally so a hand-inserted image
 * matches what pasting one writes.
 */
export function wrapImageDest(url: string): string {
  const s = url.trim();
  return s.startsWith("<") && s.endsWith(">") ? s : `<${s}>`;
}

/**
 * Read one of the dialog's size boxes: a bare number (px), a percentage, or
 * empty for "auto". A trailing `px` is accepted and dropped. Returns null when
 * the text can't be understood, so the dialog can report it instead of writing
 * junk into the note.
 */
export function parseImageDimension(text: string): string | null {
  const v = text.trim().toLowerCase().replace(/px$/, "").trim();
  if (!v) return "";
  return new RegExp(String.raw`^${DIM}$`).test(v) ? v : null;
}

/** A size as a CSS length: a bare number is px, a percentage stays one. */
export function cssLength(v: string): string {
  return /^\d+(?:\.\d+)?$/.test(v) ? `${v}px` : v;
}

/** CSS for an explicit size; empty when nothing is set. */
export function imageSizeStyle(size: ImageSize): string {
  let css = "";
  if (size.width) css += `width:${cssLength(size.width)};`;
  if (size.height) css += `height:${cssLength(size.height)};`;
  return css;
}

/** Append declarations to an existing inline style, keeping it well-formed. */
export function appendStyle(existing: string, extra: string): string {
  if (!extra) return existing;
  const base = existing.trim();
  return base ? `${base.replace(/;?$/, ";")}${extra}` : extra;
}

// --- HTML <img> -------------------------------------------------------------

/** One attribute of an `<img>` tag; `value` is null for a bare attribute. */
export interface ImgAttr {
  name: string;
  value: string | null;
}

/** An `<img …>` tag. Scanning-friendly (global, case-insensitive). */
export const IMG_TAG_RE = /<img\b[^<>]*>/gi;

const ATTR_RE =
  /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'`=<>]+))?/g;

/** Attributes this app writes itself; anything else is a hand-written extra
 *  that must survive a rewrite (and blocks the way back to `![](…)`). */
const KNOWN_IMG_ATTRS = new Set(["src", "alt", "title", "width", "height"]);

function decodeAttr(v: string): string {
  return v
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function encodeAttr(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** Split an `<img …>` tag into its attributes, values already decoded. */
export function parseImgTag(tag: string): ImgAttr[] {
  const inner = tag.replace(/^<img/i, "").replace(/\/?>$/, "");
  const attrs: ImgAttr[] = [];
  ATTR_RE.lastIndex = 0;
  for (let m = ATTR_RE.exec(inner); m; m = ATTR_RE.exec(inner)) {
    const raw = m[2];
    const value =
      raw === undefined
        ? null
        : decodeAttr(
            raw.startsWith('"') || raw.startsWith("'")
              ? raw.slice(1, -1)
              : raw,
          );
    attrs.push({ name: m[1], value });
  }
  return attrs;
}

/** Serialise attributes back into a tag. */
export function buildImgTag(attrs: ImgAttr[]): string {
  const parts = attrs.map((a) =>
    a.value === null ? a.name : `${a.name}="${encodeAttr(a.value)}"`,
  );
  return `<img${parts.length ? " " + parts.join(" ") : ""}>`;
}

/** Set an attribute in place, append it when new, drop it when the value is
 *  empty — so clearing a size removes `width`/`height` instead of blanking it. */
export function setImgAttr(
  attrs: ImgAttr[],
  name: string,
  value: string,
): ImgAttr[] {
  const lower = name.toLowerCase();
  if (value === "")
    return attrs.filter((a) => a.name.toLowerCase() !== lower);
  const next = attrs.map((a) =>
    a.name.toLowerCase() === lower ? { ...a, value } : a,
  );
  return next.some((a) => a.name.toLowerCase() === lower)
    ? next
    : [...next, { name, value }];
}

export function getImgAttr(attrs: ImgAttr[], name: string): string {
  return attrs.find((a) => a.name.toLowerCase() === name)?.value ?? "";
}

/** Whether the tag only carries attributes this app manages, so it can go back
 *  to the plain `![](…)` form once its size is cleared. */
export function isPlainImgTag(attrs: ImgAttr[]): boolean {
  return attrs.every((a) => KNOWN_IMG_ATTRS.has(a.name.toLowerCase()));
}
