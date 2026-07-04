// Markdown heading extraction for the sidebar outline panel.

export interface OutlineItem {
  /** Heading depth, 1-6. */
  level: number;
  /** Heading text with basic inline markup stripped. */
  text: string;
  /** 0-based line number in the document. */
  line: number;
}

/** Strip inline markdown (links, emphasis, code) down to readable text. */
function plainText(raw: string): string {
  return raw
    .replace(/\s+#+\s*$/, "") // trailing closing hashes of ATX headings
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links
    .replace(/`([^`]+)`/g, "$1") // inline code
    .replace(/(\*\*|__)(.+?)\1/g, "$2") // bold
    .replace(/(\*|_)(.+?)\1/g, "$2") // italic
    .replace(/~~(.+?)~~/g, "$1") // strikethrough
    .trim();
}

/** Scan markdown for ATX headings, ignoring those inside fenced code blocks. */
export function extractOutline(markdown: string): OutlineItem[] {
  const items: OutlineItem[] = [];
  let fence: string | null = null; // the fence marker we are inside, if any

  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      if (!fence) {
        fence = fenceMatch[1][0]; // opening fence: remember ` or ~
      } else if (fenceMatch[1][0] === fence) {
        fence = null; // matching closing fence
      }
      continue;
    }
    if (fence) continue;

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+)/);
    if (heading) {
      const text = plainText(heading[2]);
      if (text) items.push({ level: heading[1].length, text, line: i });
    }
  }
  return items;
}
