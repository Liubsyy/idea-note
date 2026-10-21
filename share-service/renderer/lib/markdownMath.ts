import type MarkdownIt from "markdown-it";
import katex from "katex";

/** Shared math syntax for static Markdown widgets and PDF export. */
export function addMathRules(md: MarkdownIt) {
  type RuleInline = Parameters<typeof md.inline.ruler.after>[2];
  type RuleBlock = Parameters<typeof md.block.ruler.after>[2];
  type StateInline = Parameters<RuleInline>[0];

  // --- KaTeX math rules -------------------------------------------------------
  // Ported from the well-worn markdown-it-katex algorithm; renders with the same
  // KaTeX (and globally-imported CSS) the editor's math.ts already loads.

  function renderKatex(tex: string, display: boolean): string {
    try {
      return katex.renderToString(tex, {
        displayMode: display,
        throwOnError: false,
      });
    } catch {
      const esc = md.utils.escapeHtml(tex);
      return display
        ? `<pre class="print-math-error">${esc}</pre>`
        : `<code class="print-math-error">${esc}</code>`;
    }
  }

  // A `$` is a valid opener only if not followed by whitespace, and a valid
  // closer only if not preceded by whitespace and not followed by a digit —
  // this keeps prose like "it cost $5 and $6" from parsing as math.
  function isValidDelim(state: StateInline, pos: number) {
    const prev = pos > 0 ? state.src.charCodeAt(pos - 1) : -1;
    const next = pos + 1 <= state.posMax ? state.src.charCodeAt(pos + 1) : -1;
    let canOpen = true;
    let canClose = true;
    if (prev === 0x20 || prev === 0x09 || (next >= 0x30 && next <= 0x39))
      canClose = false;
    if (next === 0x20 || next === 0x09) canOpen = false;
    return { canOpen, canClose };
  }

  const mathInline: RuleInline = (state, silent) => {
    if (state.src[state.pos] !== "$") return false;

    let res = isValidDelim(state, state.pos);
    if (!res.canOpen) {
      if (!silent) state.pending += "$";
      state.pos += 1;
      return true;
    }

    // Find the closing `$`, skipping escaped ones (odd run of backslashes).
    const start = state.pos + 1;
    let match = start;
    while ((match = state.src.indexOf("$", match)) !== -1) {
      let pos = match - 1;
      while (state.src[pos] === "\\") pos -= 1;
      if ((match - pos) % 2 === 1) break;
      match += 1;
    }

    if (match === -1) {
      if (!silent) state.pending += "$";
      state.pos = start;
      return true;
    }
    if (match - start === 0) {
      if (!silent) state.pending += "$$";
      state.pos = start + 1;
      return true;
    }

    res = isValidDelim(state, match);
    if (!res.canClose) {
      if (!silent) state.pending += "$";
      state.pos = start;
      return true;
    }

    if (!silent) {
      const token = state.push("math_inline", "math", 0);
      token.markup = "$";
      token.content = state.src.slice(start, match);
    }
    state.pos = match + 1;
    return true;
  };

  const mathBlock: RuleBlock = (state, start, end, silent) => {
    let pos = state.bMarks[start] + state.tShift[start];
    let max = state.eMarks[start];
    if (pos + 2 > max) return false;
    if (state.src.slice(pos, pos + 2) !== "$$") return false;

    pos += 2;
    let firstLine = state.src.slice(pos, max);
    if (silent) return true;

    let found = false;
    if (firstLine.trim().slice(-2) === "$$") {
      firstLine = firstLine.trim().slice(0, -2);
      found = true;
    }

    let next = start;
    let lastLine = "";
    while (!found) {
      next += 1;
      if (next >= end) break;
      pos = state.bMarks[next] + state.tShift[next];
      max = state.eMarks[next];
      if (pos < max && state.tShift[next] < state.blkIndent) break;
      if (state.src.slice(pos, max).trim().slice(-2) === "$$") {
        const lastPos = state.src.slice(0, max).lastIndexOf("$$");
        lastLine = state.src.slice(pos, lastPos);
        found = true;
      }
    }

    state.line = next + 1;
    const token = state.push("math_block", "math", 0);
    token.block = true;
    token.content =
      (firstLine.trim() ? firstLine + "\n" : "") +
      state.getLines(start + 1, next, state.tShift[start], true) +
      (lastLine.trim() ? lastLine : "");
    token.map = [start, state.line];
    token.markup = "$$";
    return true;
  };

  md.inline.ruler.after("escape", "math_inline", mathInline);
  md.block.ruler.after("blockquote", "math_block", mathBlock, {
    alt: ["paragraph", "reference", "blockquote", "list"],
  });
  md.renderer.rules.math_inline = (tokens, idx) =>
    renderKatex(tokens[idx].content, false);
  md.renderer.rules.math_block = (tokens, idx) =>
    renderKatex(tokens[idx].content, true) + "\n";
}
