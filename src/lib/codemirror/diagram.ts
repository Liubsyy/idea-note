// Mermaid diagram rendering for fenced ```mermaid code blocks.
//
// Like tablePreview/mathBlock, a fenced block spans line breaks, so it must be
// rendered as a block widget from a StateField. Mermaid renders asynchronously,
// so the widget inserts an empty container synchronously and fills in the SVG
// once `mermaid.render` resolves; results are cached by (theme + source) so the
// frequent StateField rebuilds (every selection change) don't re-render.

// NOTE: mermaid is loaded with a dynamic import() on purpose. On older WebKit
// (macOS 12 / Safari 15) some of its dependencies use regex features the engine
// rejects at parse time; a static import would turn that into a top-level
// SyntaxError and white-screen the app. A dynamic import surfaces it as a
// catchable promise rejection, so we degrade to an error message instead.
import { EditorState, Range, StateField } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";

const svgCache = new Map<string, string>();
let idCounter = 0;

const currentTheme = (): "dark" | "default" =>
  document.documentElement.classList.contains("dark") ? "dark" : "default";

const cacheKey = (theme: string, code: string) => `${theme}\n${code}`;

type MermaidApi = (typeof import("mermaid"))["default"];
let mermaidApi: Promise<MermaidApi> | null = null;

/** Lazily import mermaid; reused across renders. May reject on old WebKit. */
function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidApi)
    // mermaid uses `new CSSStyleSheet()` unconditionally; on Safari < 16.4
    // that throws "Illegal constructor". Load the constructable-stylesheets
    // polyfill first so the API exists. It no-ops on browsers that support it.
    mermaidApi = import("construct-style-sheets-polyfill")
      .then(() => import("mermaid"))
      .then((m) => m.default);
  return mermaidApi;
}

async function renderDiagram(
  view: EditorView,
  code: string,
  theme: string,
  wrap: HTMLElement,
) {
  const renderId = `mermaid-${idCounter++}`;
  try {
    const mermaid = await loadMermaid();
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: theme === "dark" ? "dark" : "default",
      fontFamily: "inherit",
    });
    const { svg } = await mermaid.render(renderId, code);
    svgCache.set(cacheKey(theme, code), svg);
    if (!wrap.isConnected) return;
    wrap.innerHTML = svg;
  } catch (e) {
    // On a parse error mermaid 10 draws its "Syntax error in text" bomb into
    // a temp <div id="d{id}"> appended to document.body and throws BEFORE its
    // own cleanup, leaking the node (it would even show up in printed PDFs).
    document.getElementById(`d${renderId}`)?.remove();
    document.getElementById(renderId)?.remove();
    wrap.classList.add("cm-md-mermaid-error");
    wrap.textContent = `图表渲染失败：${e instanceof Error ? e.message : String(e)}`;
  }
  // The async fill changes the widget height; ask CodeMirror to re-measure.
  view.requestMeasure();
}

class MermaidWidget extends WidgetType {
  readonly theme: string;
  constructor(
    readonly code: string,
    readonly from: number,
  ) {
    super();
    this.theme = currentTheme();
  }
  eq(o: MermaidWidget) {
    return o.code === this.code && o.theme === this.theme;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "cm-md-mermaid";
    // Click to edit: drop the caret into the source so the block reveals.
    wrap.addEventListener("mousedown", (e) => {
      e.preventDefault();
      view.dispatch({ selection: { anchor: this.from } });
      view.focus();
    });
    const cached = svgCache.get(cacheKey(this.theme, this.code));
    if (cached) wrap.innerHTML = cached;
    else void renderDiagram(view, this.code, this.theme, wrap);
    return wrap;
  }
  ignoreEvent() {
    return false;
  }
}

/** A ```mermaid opening fence line (3+ backticks or tildes). */
export const MERMAID_FENCE = /^\s*(`{3,}|~{3,})\s*mermaid\s*$/i;

const isCloseFence = (text: string, ch: string, len: number): boolean => {
  const t = text.trim();
  if (t.length < len) return false;
  for (const c of t) if (c !== ch) return false;
  return true;
};

function buildDiagrams(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const doc = state.doc;
  let i = 1;
  while (i <= doc.lines) {
    const line = doc.line(i);
    const m = line.text.match(MERMAID_FENCE);
    if (!m) {
      i++;
      continue;
    }
    const ch = m[1][0];
    const len = m[1].length;
    let j = i + 1;
    while (j <= doc.lines && !isCloseFence(doc.line(j).text, ch, len)) j++;
    const closeLine = j <= doc.lines ? j : doc.lines;
    const from = line.from;
    const to = doc.line(closeLine).to;
    // Read-only mode never edits, so keep the diagram rendered even when the
    // block is selected.
    const inside =
      !state.readOnly &&
      state.selection.ranges.some((r) => r.from <= to && r.to >= from);
    if (!inside && j > i + 1) {
      const code = doc
        .sliceString(doc.line(i + 1).from, doc.line(j - 1).to)
        .replace(/\s+$/, "");
      if (code.trim())
        ranges.push(
          Decoration.replace({
            widget: new MermaidWidget(code, from),
            block: true,
          }).range(from, to),
        );
    }
    i = closeLine + 1;
  }
  return Decoration.set(ranges, true);
}

export const mermaidBlock = StateField.define<DecorationSet>({
  create: (state) => buildDiagrams(state),
  update(deco, tr) {
    if (
      tr.docChanged ||
      tr.selection ||
      tr.startState.readOnly !== tr.state.readOnly
    )
      return buildDiagrams(tr.state);
    return deco.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});
