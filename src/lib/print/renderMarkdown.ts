import { tr } from "../../i18n/core.ts";
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
import { addMathRules } from "../markdownMath";

import { toDisplaySrc } from "../imagePath";
import { appendStyle, imageSizeStyle, parseImageDest } from "../imageSyntax";
import {
  highlightBackgroundCss,
  isCustomHighlightColor,
  highlightTagAtStart,
} from "../highlightBlock";
import { fenceLang } from "../codeRun/runners";
import { parseInputBlock } from "../inputs/schema";

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
// CommonMark, so markdown-it's image rule rejects `![](assets/image 3.png)` —
// and equally `![](<a.png> =300x200)`, the app's explicit-size form — and the
// path would print as literal text (dropping the image from the PDF).
// The editor's live preview hand-recovers exactly these shapes (livePreview.ts,
// "Image" case); mirror it here so preview and export stay in sync. Registered
// after "image", so it only fires where the strict rule already failed.
const spacedImage: RuleInline = (state, silent) => {
  if (state.src.charCodeAt(state.pos) !== 0x21 /* ! */) return false;
  const m = /^!\[([^\]\n]*)\]\(([^)\n]+)\)/.exec(state.src.slice(state.pos));
  if (!m) return false;
  if (!silent) {
    const { dest, size, title } = parseImageDest(m[2]);
    const token = state.push("image", "img", 0);
    token.attrs = [
      ["src", dest],
      ["alt", ""],
    ];
    const style = imageSizeStyle(size);
    if (style) token.attrs.push(["style", style]);
    if (title) token.attrs.push(["title", title]);
    token.content = m[1];
    token.children = [];
    state.md.inline.parse(m[1], state.md, state.env, token.children);
  }
  state.pos += m[0].length;
  return true;
};
md.inline.ruler.after("image", "spaced_image", spacedImage);

/**
 * ```input blocks print as a table of parameters and their values.
 *
 * The exported document is a snapshot, so it shows the defaults the note
 * carries — a PDF has no sliders, and nothing here ever runs the block that
 * reads them (export must never execute code).
 */
function renderInputTable(source: string): string {
  const schema = parseInputBlock(source);
  if (schema.fields.length === 0) return "";
  const rows = schema.fields
    .map((f) => {
      const value = `${String(f.value)}${f.unit ? ` ${f.unit}` : ""}`;
      return `<tr><td>${md.utils.escapeHtml(f.label)}</td><td>${md.utils.escapeHtml(
        value,
      )}</td></tr>`;
    })
    .join("");
  return tr("<table class=\"print-input\"><thead><tr><th>参数</th><th>值</th></tr></thead><tbody>{{0}}</tbody></table>", { 0: rows });
}

// ```mermaid fences become placeholders; renderMarkdownToHtml fills in the SVG
// asynchronously. ```input renders as a parameter table. Every other fence
// keeps the default <pre><code> rendering.
const defaultFenceRule = md.renderer.rules.fence;
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const lang = fenceLang(token.info);
  if (lang === "mermaid")
    return `<div class="print-mermaid" data-mermaid="${md.utils.escapeHtml(
      token.content,
    )}"></div>`;
  if (lang === "input") {
    const table = renderInputTable(token.content);
    if (table) return table;
  }
  return defaultFenceRule
    ? defaultFenceRule(tokens, idx, options, env, self)
    : self.renderToken(tokens, idx, options);
};

addMathRules(md);

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

// Idea Note highlight blocks remain valid Markdown blockquotes on disk. Remove
// the extension marker after rendering and add a print-only class to the quote.
function applyHighlightBlocks(root: DocumentFragment) {
  root.querySelectorAll("blockquote").forEach((blockquote) => {
    const first = blockquote.firstElementChild;
    if (!first || first.tagName !== "P") return;
    const marker = highlightTagAtStart(first.innerHTML);
    if (!marker) return;
    const content = first.innerHTML
      .slice(marker.length)
      .replace(/^(?:\r?\n|<br\s*\/?>)?\s*/i, "");
    blockquote.classList.add("print-highlight-block");
    blockquote.style.setProperty(
      "--print-highlight-code-background",
      highlightBackgroundCss(marker.color, 0.2),
    );
    if (isCustomHighlightColor(marker.color)) {
      blockquote.classList.add("print-highlight-custom");
      blockquote.style.setProperty("--print-highlight-color", marker.color);
      blockquote.style.setProperty(
        "--print-highlight-background",
        highlightBackgroundCss(marker.color, 0.14),
      );
    } else {
      blockquote.classList.add(`print-highlight-${marker.color}`);
    }
    if (content.trim()) first.innerHTML = content;
    else first.remove();
  });
}

// --- Public API -------------------------------------------------------------

export async function renderMarkdownToHtml(markdown: string): Promise<string> {
  const tpl = document.createElement("template");
  tpl.innerHTML = md.render(markdown ?? "");

  applyTaskLists(tpl.content);
  applyHighlightBlocks(tpl.content);

  // Raw `<img>` tags (the form a sized image takes) reach here verbatim: markdown-it
  // only routes its own image tokens through the rule above. Resolve their paths
  // the same way, and restate width/height as a style so print.css's
  // `img { height: auto }` can't drop an explicit height.
  tpl.content.querySelectorAll("img").forEach((img) => {
    const raw = img.getAttribute("src");
    if (raw) img.setAttribute("src", toDisplaySrc(raw));
    const style = imageSizeStyle({
      width: img.getAttribute("width") ?? "",
      height: img.getAttribute("height") ?? "",
    });
    if (style)
      img.setAttribute(
        "style",
        appendStyle(img.getAttribute("style") ?? "", style),
      );
  });

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
