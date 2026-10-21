import MarkdownIt from "markdown-it";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightTree } from "@lezer/highlight";
import { addMathRules } from "../markdownMath";
import { parseImageDest, imageSizeStyle } from "../imageSyntax";
import { highlightTagAtStart, highlightColorCss, highlightBackgroundCss } from "../highlightBlock";
import { renderMermaidSvg } from "./diagram";
import { codeHighlight } from "./theme";
import type { EditorView } from "@codemirror/view";
import { createCodeActions, destroyCodeActions } from "./codeActions";
import { canInteract } from "./interaction";
import { fenceLang, resolveRunner } from "../codeRun/runners";
import { useAppStore } from "../../store/useAppStore";

const md = new MarkdownIt({ html: true, linkify: true });
addMathRules(md);

// Preserve the complete fence info (including input/output attributes) across
// sanitization so the shared run action receives the same data as regular code.
for (const rule of ["fence", "code_block"] as const) {
  const render = md.renderer.rules[rule]!;
  md.renderer.rules[rule] = (tokens, index, options, env, self) =>
    render(tokens, index, options, env, self).replace("<pre>",
      `<pre data-code-info="${md.utils.escapeHtml(tokens[index].info)}">`);
}

// Native disclosure tags are containers, not opaque HTML paragraphs. Let the
// Markdown body start immediately after summary, even without a blank line.
md.block.ruler.before("html_block", "details_container", (state, start, _end, silent) => {
  if (state.sCount[start] - state.blkIndent >= 4) return false;
  const line = state.src.slice(state.bMarks[start] + state.tShift[start], state.eMarks[start]);
  if (!/^(?:<\/?details\b(?:[^"'<>]|"[^"]*"|'[^']*')*>|<summary\b[^>]*>.*<\/summary>)\s*$/i.test(line)) return false;
  if (silent) return true;
  const token = state.push("html_block", "", 0);
  token.block = true;
  token.content = line + "\n";
  token.map = [start, start + 1];
  state.line = start + 1;
  return true;
}, { alt: ["paragraph", "reference", "blockquote", "list"] });

// Match the editor's lenient image destinations, including explicit sizes.
md.inline.ruler.after("image", "details_sized_image", (state, silent) => {
  const match = /^!\[([^\]\n]*)\]\(([^)\n]+)\)/.exec(state.src.slice(state.pos));
  if (!match) return false;
  if (!silent) {
    const { dest, size, title } = parseImageDest(match[2]);
    const token = state.push("image", "img", 0);
    token.attrs = [["src", dest], ["alt", ""]];
    const style = imageSizeStyle(size);
    if (style) token.attrs.push(["style", style]);
    if (title) token.attrs.push(["title", title]);
    token.content = match[1];
    token.children = [];
    state.md.inline.parse(match[1], state.md, state.env, token.children);
  }
  state.pos += match[0].length;
  return true;
});

export function renderDetailsMarkdown(source: string): string {
  return md.render(source);
}

/** Enhance sanitized widget DOM; async rendering never changes the note. */
export function enhanceDetailsMarkdown(root: HTMLElement, view: EditorView, onSettle: () => void) {
  root.querySelectorAll("code").forEach(code => {
    if (code.parentElement?.tagName !== "PRE") code.classList.add("cm-md-code");
  });
  root.querySelectorAll("a[href]").forEach(link => link.classList.add("cm-md-link"));
  root.querySelectorAll("li").forEach(li => {
    const container = li.firstElementChild?.tagName === "P" ? li.firstElementChild : li;
    const text = container.firstChild;
    const match = text?.nodeType === Node.TEXT_NODE && /^\[([ xX])\]\s+/.exec(text.textContent ?? "");
    if (!match || !text) return;
    text.textContent = text.textContent!.slice(match[0].length);
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = match[1] !== " ";
    // Editing remains through the block's source control, including in read-only mode.
    checkbox.disabled = true;
    container.insertBefore(checkbox, text);
    li.classList.add("cm-md-details-task");
  });
  root.querySelectorAll<HTMLElement>("blockquote").forEach(quote => {
    const first = quote.firstElementChild;
    if (first?.tagName !== "P") return;
    const marker = highlightTagAtStart(first.innerHTML);
    if (!marker) return;
    first.innerHTML = first.innerHTML.slice(marker.length).replace(/^\s*(?:<br\s*\/?>)?\s*/i, "");
    if (!first.textContent?.trim() && !first.children.length) first.remove();
    quote.classList.add("cm-md-details-highlight");
    quote.style.setProperty("--md-highlight-color", highlightColorCss(marker.color));
    quote.style.setProperty("--md-highlight-background", highlightBackgroundCss(marker.color));
    quote.style.setProperty("--md-highlight-code-background", highlightBackgroundCss(marker.color, 0.2));
  });
  root.querySelectorAll<HTMLElement>("pre > code").forEach(code => {
    const language = fenceLang(code.parentElement?.dataset.codeInfo ?? "") ||
      [...code.classList].find(name => name.startsWith("language-"))?.slice(9);
    const source = code.textContent ?? "";
    if (language?.toLowerCase() === "mermaid") {
      const host = code.parentElement!;
      void renderMermaidSvg(source.trim()).then(result => {
        if (!root.isConnected) return;
        if ("svg" in result) {
          const diagram = document.createElement("div");
          diagram.className = "cm-md-details-mermaid";
          // renderMermaidSvg already sanitized this with the SVG profile; the
          // HTML profile would discard its foreignObject-based text labels.
          diagram.innerHTML = result.svg;
          host.replaceWith(diagram);
        }
        // Keep the original source available if diagram rendering fails.
        onSettle();
      });
      return;
    }
    bindCodeActions(code, view, onSettle);
    const description = language && LanguageDescription.matchLanguageName(languages, language, true);
    if (!description) return;
    void description.load().then(support => {
      if (!root.isConnected) return;
      const fragment = document.createDocumentFragment();
      let position = 0;
      highlightTree(support.language.parser.parse(source), codeHighlight, (from, to, classes) => {
        fragment.append(source.slice(position, from));
        const span = document.createElement("span");
        span.className = classes;
        span.textContent = source.slice(from, to);
        fragment.append(span);
        position = to;
      });
      fragment.append(source.slice(position));
      code.replaceChildren(fragment);
      onSettle();
    }).catch(() => { /* Unsupported languages retain readable plain code. */ });
  });
}

function bindCodeActions(code: HTMLElement, view: EditorView, onSettle: () => void) {
  const pre = code.parentElement!;
  let shell = pre.parentElement!;
  if (!shell.classList.contains("cm-md-details-code")) {
    shell = document.createElement("div");
    shell.className = "cm-md-details-code";
    pre.before(shell);
    shell.append(pre);
  }
  const previous = shell.querySelector<HTMLElement>(".cm-md-code-header");
  if (previous) {
    destroyCodeActions(previous);
    previous.remove();
  }
  const info = pre.getAttribute("data-code-info");
  // Markdown-it terminates every code token with a newline. Copy/run the body
  // using the same convention as ordinary code blocks, preserving blank lines.
  const source = info === null ? code.textContent ?? "" : (code.textContent ?? "").replace(/\n$/, "");
  const language = fenceLang(info ?? "") ||
    [...code.classList].find(name => name.startsWith("language-"))?.slice(9) || "";
  shell.prepend(createCodeActions(view, {
    code: source,
    language,
    lineCount: source ? source.split("\n").length : 0,
    runInfo: info !== null && canInteract(view.state) &&
      resolveRunner(info, useAppStore.getState().codeRunConfig) ? info : null,
    fold: source ? {
      collapsed: () => pre.hidden,
      toggle: () => {
        view.dispatch({ effects: view.scrollSnapshot() });
        pre.hidden = !pre.hidden;
        shell.classList.toggle("is-collapsed", pre.hidden);
        onSettle();
      },
    } : undefined,
  }));
}

/** Settings updates refresh controls without losing native disclosure state. */
export function refreshDetailsCodeActions(root: HTMLElement, view: EditorView, onSettle: () => void) {
  root.querySelectorAll<HTMLElement>(".cm-md-details-code > pre > code").forEach(code =>
    bindCodeActions(code, view, onSettle));
}
