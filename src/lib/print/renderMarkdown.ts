// Markdown → self-contained HTML for printing / "Save as PDF".
//
// The app renders notes through CodeMirror's live preview, which is virtualised
// and editor-coupled, so it can't produce a clean static snapshot. Instead we
// re-render the raw markdown with markdown-it and reuse the app's existing
// pieces for the parts markdown-it doesn't cover:
//   - images  → toDisplaySrc() (asset-protocol / relative-path resolution)
//   - `$…$` / `$$…$$` → KaTeX (same library the editor uses)
//   - ```mermaid → mermaid.render() SVG (light theme for print)
// Mermaid is async, so the whole thing is async.

import MarkdownIt from "markdown-it";
import katex from "katex";

import { toDisplaySrc } from "../imagePath";

// --- mermaid (replicates diagram.ts's lazy, WebKit-safe loader) -------------

type MermaidApi = (typeof import("mermaid"))["default"];
let mermaidApi: Promise<MermaidApi> | null = null;
let mermaidId = 0;

function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidApi)
    // mermaid uses `new CSSStyleSheet()`; polyfill it for older WebKit first.
    mermaidApi = import("construct-style-sheets-polyfill")
      .then(() => import("mermaid"))
      .then((m) => m.default);
  return mermaidApi;
}

// --- markdown-it instance ---------------------------------------------------

const md = new MarkdownIt({
  html: true, // notes may embed raw HTML, matching the editor's htmlPreview
  linkify: true,
  breaks: false,
});

// markdown-it's rule/state types live behind an `export =` namespace that
// isn't reachable through the default import; derive them from `md` instead.
type RuleInline = Parameters<typeof md.inline.ruler.after>[2];
type RuleBlock = Parameters<typeof md.block.ruler.after>[2];
type StateInline = Parameters<RuleInline>[0];

// Resolve image sources the same way the editor does so local/relative paths
// (and GitHub blob URLs) load inside the print document.
const defaultImageRule = md.renderer.rules.image;
md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const i = token.attrIndex("src");
  if (i >= 0 && token.attrs) token.attrs[i][1] = toDisplaySrc(token.attrs[i][1]);
  return defaultImageRule
    ? defaultImageRule(tokens, idx, options, env, self)
    : self.renderToken(tokens, idx, options);
};

// Typora-style leniency: a raw space in an image destination is invalid
// CommonMark, so markdown-it's image rule rejects `![](assets/image 3.png)`
// and the path would print as literal text (dropping the image from the PDF).
// The editor's live preview hand-recovers exactly this shape (livePreview.ts,
// "Image" case); mirror it here so preview and export stay in sync. Registered
// after "image", so it only fires where the strict rule already failed.
const spacedImage: RuleInline = (state, silent) => {
  if (state.src.charCodeAt(state.pos) !== 0x21 /* ! */) return false;
  const m = /^!\[([^\]\n]*)\]\(([^)\n]+)\)/.exec(state.src.slice(state.pos));
  if (!m) return false;
  if (!silent) {
    const token = state.push("image", "img", 0);
    token.attrs = [
      ["src", m[2].trim()],
      ["alt", ""],
    ];
    token.content = m[1];
    token.children = [];
    state.md.inline.parse(m[1], state.md, state.env, token.children);
  }
  state.pos += m[0].length;
  return true;
};
md.inline.ruler.after("image", "spaced_image", spacedImage);

// ```mermaid fences become placeholders; renderMarkdownToHtml fills in the SVG
// asynchronously. Every other fence keeps the default <pre><code> rendering.
const defaultFenceRule = md.renderer.rules.fence;
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  if (token.info.trim().toLowerCase() === "mermaid")
    return `<div class="print-mermaid" data-mermaid="${md.utils.escapeHtml(
      token.content,
    )}"></div>`;
  return defaultFenceRule
    ? defaultFenceRule(tokens, idx, options, env, self)
    : self.renderToken(tokens, idx, options);
};

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

// --- Task lists (`- [ ]` / `- [x]`) -----------------------------------------
// Post-process rendered <li>s into disabled checkboxes; handles both tight
// (`<li>[ ] x</li>`) and loose (`<li><p>[ ] x</p></li>`) list output.

function applyTaskLists(root: DocumentFragment) {
  root.querySelectorAll("li").forEach((li) => {
    const replaced = li.innerHTML.replace(
      /^(\s*(?:<p[^>]*>)?\s*)\[([ xX])\]\s+/,
      (_m, pre: string, mark: string) =>
        `${pre}<input type="checkbox" class="print-task-checkbox" disabled${
          mark === " " ? "" : " checked"
        }> `,
    );
    if (replaced !== li.innerHTML) {
      li.innerHTML = replaced;
      li.classList.add("print-task-item");
    }
  });
}

// --- Public API -------------------------------------------------------------

export async function renderMarkdownToHtml(markdown: string): Promise<string> {
  const tpl = document.createElement("template");
  tpl.innerHTML = md.render(markdown ?? "");

  applyTaskLists(tpl.content);

  const mermaidNodes = Array.from(
    tpl.content.querySelectorAll<HTMLElement>("div.print-mermaid"),
  );
  if (mermaidNodes.length) {
    const toRawPre = (node: HTMLElement) => {
      const pre = document.createElement("pre");
      pre.textContent = node.getAttribute("data-mermaid") ?? "";
      node.replaceWith(pre);
    };
    try {
      const mermaid = await loadMermaid();
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "default", // force light rendering for print
        fontFamily: "inherit",
      });
      for (const node of mermaidNodes) {
        const code = node.getAttribute("data-mermaid") ?? "";
        const renderId = `print-mermaid-${mermaidId++}`;
        try {
          const { svg } = await mermaid.render(renderId, code);
          const wrap = document.createElement("div");
          wrap.className = "print-mermaid";
          wrap.innerHTML = svg;
          node.replaceWith(wrap);
        } catch {
          // mermaid 10 leaks its error SVG into document.body before throwing;
          // remove it or it gets printed into the exported PDF.
          document.getElementById(`d${renderId}`)?.remove();
          document.getElementById(renderId)?.remove();
          toRawPre(node); // one bad diagram shouldn't break the whole print
        }
      }
    } catch {
      mermaidNodes.forEach(toRawPre); // mermaid failed to load entirely
    }
  }

  return tpl.innerHTML;
}
