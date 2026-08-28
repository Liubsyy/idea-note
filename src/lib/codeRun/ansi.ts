// ANSI SGR rendering for the code-run panel.
//
// Build tools commonly write progress to stderr even when nothing is wrong.
// When stderr contains terminal styling, honour that styling and use the
// terminal's normal foreground after a reset. Plain, unstyled stderr keeps the
// panel's error colour.

export type OutputStream = "stdout" | "stderr";

interface OutputSegment {
  stream: OutputStream;
  text: string;
}

export interface AnsiTextRun {
  text: string;
  style: {
    color: string;
    backgroundColor?: string;
    fontWeight?: number;
    fontStyle?: "italic";
    textDecoration?: string;
    opacity?: number;
    visibility?: "hidden";
  };
}

interface AnsiState {
  foreground: string | null;
  background: string | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  inverse: boolean;
  hidden: boolean;
  pending: string;
}

const NORMAL_COLORS = [
  "var(--ansi-black)",
  "var(--ansi-red)",
  "var(--ansi-green)",
  "var(--ansi-yellow)",
  "var(--ansi-blue)",
  "var(--ansi-magenta)",
  "var(--ansi-cyan)",
  "var(--ansi-white)",
];

const BRIGHT_COLORS = [
  "var(--ansi-bright-black)",
  "var(--ansi-bright-red)",
  "var(--ansi-bright-green)",
  "var(--ansi-bright-yellow)",
  "var(--ansi-bright-blue)",
  "var(--ansi-bright-magenta)",
  "var(--ansi-bright-cyan)",
  "var(--ansi-bright-white)",
];

const freshState = (): AnsiState => ({
  foreground: null,
  background: null,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  strike: false,
  inverse: false,
  hidden: false,
  pending: "",
});

function indexedColor(index: number): string | null {
  if (!Number.isInteger(index) || index < 0 || index > 255) return null;
  if (index < 8) return NORMAL_COLORS[index];
  if (index < 16) return BRIGHT_COLORS[index - 8];
  if (index < 232) {
    const n = index - 16;
    const levels = [0, 95, 135, 175, 215, 255];
    const r = levels[Math.floor(n / 36)];
    const g = levels[Math.floor((n % 36) / 6)];
    const b = levels[n % 6];
    return `rgb(${r}, ${g}, ${b})`;
  }
  const gray = 8 + (index - 232) * 10;
  return `rgb(${gray}, ${gray}, ${gray})`;
}

function rgbColor(values: Array<number | null>, from: number) {
  const rgb: number[] = [];
  let end = from;
  while (end < values.length && rgb.length < 3) {
    const value = values[end];
    if (value !== null) rgb.push(value);
    end += 1;
  }
  if (rgb.length !== 3 || rgb.some((v) => v < 0 || v > 255)) {
    return { color: null, end };
  }
  return { color: `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`, end };
}

function applySgr(state: AnsiState, raw: string): void {
  const values = (raw === "" ? [0] : raw.split(/[;:]/).map((part) => {
    if (part === "") return null;
    const value = Number(part);
    return Number.isFinite(value) ? value : null;
  }));

  for (let i = 0; i < values.length; i += 1) {
    const code = values[i] ?? 0;
    if (code === 0) {
      const pending = state.pending;
      Object.assign(state, freshState(), { pending });
    } else if (code === 1) state.bold = true;
    else if (code === 2) state.dim = true;
    else if (code === 3) state.italic = true;
    else if (code === 4) state.underline = true;
    else if (code === 7) state.inverse = true;
    else if (code === 8) state.hidden = true;
    else if (code === 9) state.strike = true;
    else if (code === 22) {
      state.bold = false;
      state.dim = false;
    } else if (code === 23) state.italic = false;
    else if (code === 24) state.underline = false;
    else if (code === 27) state.inverse = false;
    else if (code === 28) state.hidden = false;
    else if (code === 29) state.strike = false;
    else if (code >= 30 && code <= 37) state.foreground = NORMAL_COLORS[code - 30];
    else if (code === 39) state.foreground = null;
    else if (code >= 40 && code <= 47) state.background = NORMAL_COLORS[code - 40];
    else if (code === 49) state.background = null;
    else if (code >= 90 && code <= 97) state.foreground = BRIGHT_COLORS[code - 90];
    else if (code >= 100 && code <= 107) state.background = BRIGHT_COLORS[code - 100];
    else if (code === 38 || code === 48) {
      const target = code === 38 ? "foreground" : "background";
      const mode = values[i + 1];
      const paletteIndex = values[i + 2];
      if (mode === 5 && paletteIndex !== null && paletteIndex !== undefined) {
        state[target] = indexedColor(paletteIndex);
        i += 2;
      } else if (mode === 2) {
        const parsed = rgbColor(values, i + 2);
        state[target] = parsed.color;
        i = parsed.end - 1;
      }
    }
  }
}

function styleFor(state: AnsiState, fallbackColor: string): AnsiTextRun["style"] {
  let color = state.foreground ?? fallbackColor;
  let backgroundColor = state.background ?? undefined;
  if (state.inverse) {
    const oldColor = color;
    color = backgroundColor ?? "var(--bg-elev)";
    backgroundColor = oldColor;
  }
  const decorations = [state.underline ? "underline" : "", state.strike ? "line-through" : ""]
    .filter(Boolean)
    .join(" ");
  return {
    color,
    ...(backgroundColor ? { backgroundColor } : {}),
    ...(state.bold ? { fontWeight: 700 } : {}),
    ...(state.italic ? { fontStyle: "italic" as const } : {}),
    ...(decorations ? { textDecoration: decorations } : {}),
    ...(state.dim ? { opacity: 0.65 } : {}),
    ...(state.hidden ? { visibility: "hidden" as const } : {}),
  };
}

const styleKey = (style: AnsiTextRun["style"]) => JSON.stringify(style);

/** Convert interleaved stdout/stderr segments into safe text runs. ANSI state
 * is tracked independently for each pipe, just as it is in a real terminal. */
export function parseAnsiSegments(segments: readonly OutputSegment[]): AnsiTextRun[] {
  const styledStreams = new Set<OutputStream>();
  const streamText: Record<OutputStream, string> = { stdout: "", stderr: "" };
  for (const segment of segments) {
    streamText[segment.stream] += segment.text;
  }
  for (const stream of ["stdout", "stderr"] as const) {
    if (/\x1b\[[0-9;:]*m|\x9b[0-9;:]*m/.test(streamText[stream])) styledStreams.add(stream);
  }

  const states: Record<OutputStream, AnsiState> = {
    stdout: freshState(),
    stderr: freshState(),
  };
  const runs: AnsiTextRun[] = [];

  const append = (text: string, state: AnsiState, fallback: string) => {
    if (!text) return;
    const style = styleFor(state, fallback);
    const last = runs[runs.length - 1];
    if (last && styleKey(last.style) === styleKey(style)) last.text += text;
    else runs.push({ text, style });
  };

  for (const segment of segments) {
    const state = states[segment.stream];
    const fallback =
      segment.stream === "stderr" && !styledStreams.has("stderr")
        ? "var(--danger, #e5484d)"
        : "var(--text)";
    const input = state.pending + segment.text;
    state.pending = "";
    let plainStart = 0;
    let i = 0;

    while (i < input.length) {
      const csi = input.charCodeAt(i) === 0x9b;
      if (input.charCodeAt(i) !== 0x1b && !csi) {
        i += 1;
        continue;
      }
      append(input.slice(plainStart, i), state, fallback);

      const start = i;
      if (!csi) {
        i += 1;
        if (i >= input.length) {
          state.pending = input.slice(start);
          plainStart = input.length;
          break;
        }
        // OSC: discard through BEL or ST. This prevents terminal-title and
        // hyperlink controls from leaking into the document UI.
        if (input[i] === "]") {
          const bel = input.indexOf("\x07", i + 1);
          const st = input.indexOf("\x1b\\", i + 1);
          const end = bel < 0 ? st : st < 0 ? bel : Math.min(bel, st);
          if (end < 0) {
            state.pending = input.slice(start);
            plainStart = input.length;
            break;
          }
          i = end + (end === st ? 2 : 1);
          plainStart = i;
          continue;
        }
        if (input[i] !== "[") {
          // A non-CSI two-byte escape has no printable representation here.
          i += 1;
          plainStart = i;
          continue;
        }
        i += 1;
      } else {
        i += 1;
      }

      const bodyStart = i;
      while (i < input.length) {
        const code = input.charCodeAt(i);
        if (code >= 0x40 && code <= 0x7e) break;
        i += 1;
      }
      if (i >= input.length) {
        state.pending = input.slice(start);
        plainStart = input.length;
        break;
      }
      if (input[i] === "m") applySgr(state, input.slice(bodyStart, i));
      i += 1;
      plainStart = i;
    }
    append(input.slice(plainStart), state, fallback);
  }
  return runs;
}
