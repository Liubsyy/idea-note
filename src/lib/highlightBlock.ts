export const HIGHLIGHT_COLORS = [
  "yellow",
  "blue",
  "green",
  "red",
  "purple",
] as const;

export type HighlightPresetColor = (typeof HIGHLIGHT_COLORS)[number];
export type HighlightColor = HighlightPresetColor | `#${string}`;

const HIGHLIGHT_COLOR_SOURCE = `(?:${HIGHLIGHT_COLORS.join("|")}|#[0-9a-f]{6})`;

const HIGHLIGHT_MARKER_RE = new RegExp(
  `^\\s*>\\s*\\[!HIGHLIGHT(?:\\s+color=(${HIGHLIGHT_COLOR_SOURCE}))?\\]\\s*$`,
  "i",
);
const HIGHLIGHT_TAG_RE = new RegExp(
  `^\\s*\\[!HIGHLIGHT(?:\\s+color=(${HIGHLIGHT_COLOR_SOURCE}))?\\](?=\\s|<br\\s*\\/?>|$)`,
  "i",
);

const HIGHLIGHT_COLOR_CSS: Record<HighlightPresetColor, string> = {
  yellow: "#eab308",
  blue: "#3b82f6",
  green: "#22c55e",
  red: "#ef4444",
  purple: "#a855f7",
};

export function parseHighlightColor(value: string): HighlightColor | null {
  const color = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(color)) return color as `#${string}`;
  return HIGHLIGHT_COLORS.includes(color as HighlightPresetColor)
    ? (color as HighlightPresetColor)
    : null;
}

function normalizedColor(raw: string | undefined): HighlightColor {
  return parseHighlightColor(raw ?? "blue") ?? "blue";
}

/** Return the marker colour, using blue for the colourless default form. */
export function highlightColorFromLine(text: string): HighlightColor | null {
  const match = text.match(HIGHLIGHT_MARKER_RE);
  if (!match) return null;
  return normalizedColor(match[1]);
}

/** Match a marker at the start of already-rendered blockquote text. */
export function highlightTagAtStart(
  text: string,
): { color: HighlightColor; length: number } | null {
  const match = text.match(HIGHLIGHT_TAG_RE);
  if (!match) return null;
  return {
    color: normalizedColor(match[1]),
    length: match[0].length,
  };
}

export function highlightColorCss(color: HighlightColor): string {
  return color.startsWith("#")
    ? color
    : HIGHLIGHT_COLOR_CSS[color as HighlightPresetColor];
}

export function isCustomHighlightColor(
  color: HighlightColor,
): color is `#${string}` {
  return color.startsWith("#");
}

export function highlightMarker(color: HighlightColor): string {
  const safeColor = parseHighlightColor(color) ?? "blue";
  return safeColor === "blue"
    ? "> [!HIGHLIGHT]"
    : `> [!HIGHLIGHT color=${safeColor}]`;
}
