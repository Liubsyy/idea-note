import { parser, GFM } from "@lezer/markdown";

export const PRESENTATION_LAYOUT_EVENT = "idea-note:presentation-layout";
const markdownParser = parser.configure(GFM);

/** Source ranges to skip between slides. Parse Markdown so code examples,
 * table separators, setext headings and nested rules remain ordinary content. */
export function presentationBreaks(source: string): { from: number; to: number }[] {
  const frontmatter = source.match(/^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/);
  const frontmatterEnd = frontmatter && /^[ \t]*[\w-]+\s*:/m.test(frontmatter[1])
    ? frontmatter[0].length : 0;
  const result: { from: number; to: number }[] = [];
  for (let node = markdownParser.parse(source).topNode.firstChild; node; node = node.nextSibling) {
    if (node.name !== "HorizontalRule" || node.from < frontmatterEnd ||
        !/^\s*(?:-\s*){3,}$/.test(source.slice(node.from, node.to))) continue;
    let from = source.lastIndexOf("\n", node.from - 1) + 1;
    while (from > 0) {
      const previous = source.lastIndexOf("\n", from - 2) + 1;
      if (source.slice(previous, from).trim()) break;
      from = previous;
    }
    const tail = source.slice(node.to).match(/^[ \t]*(?:\r?\n[ \t]*)*/)?.[0] ?? "";
    result.push({ from, to: node.to + tail.length });
  }
  return result;
}
