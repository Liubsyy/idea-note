import MarkdownIt from "markdown-it";

// Parse only when following an anchor. This leaves the editor's rendering and
// sidebar outline unchanged, and excludes headings inside code/HTML examples.
const md = new MarkdownIt({ html: true });
type Token = ReturnType<typeof md.parse>[number];

function headingText(tokens: Token[]): string {
  return tokens.map(token => {
    if (token.type === "text" || token.type === "code_inline") return token.content;
    if (token.type === "softbreak" || token.type === "hardbreak") return " ";
    if (token.type === "image") return headingText(token.children ?? []);
    return "";
  }).join("");
}

/** Automatic heading IDs: keep Unicode letters/numbers, underscores and dashes. */
function headingSlug(text: string): string {
  return text.trim().toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}_\s-]/gu, "")
    .replace(/\s+/g, "-");
}

/** Resolve a same-document fragment to a 1-based source line. */
export function findMarkdownAnchorLine(source: string, fragment: string): number | null {
  if (!fragment.startsWith("#")) return null;
  let target = fragment.slice(1);
  try { target = decodeURIComponent(target); } catch { /* Treat malformed escapes literally. */ }
  if (!target) return 1;
  target = target.toLowerCase();

  const used = new Set<string>();
  const tokens = md.parse(source, {});
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const inline = tokens[i + 1];
    if (token.type !== "heading_open" || !token.map || inline?.type !== "inline") continue;
    const base = headingSlug(headingText(inline.children ?? []));
    let slug = base;
    let suffix = 0;
    while (used.has(slug)) slug = `${base}-${++suffix}`;
    used.add(slug);
    if (slug === target) return token.map[0] + 1;
  }
  return null;
}
