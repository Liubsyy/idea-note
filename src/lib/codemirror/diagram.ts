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
const PAN_STEP = 48;
const ZOOM_STEP = 0.2;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 3;

type DiagramTransform = {
  x: number;
  y: number;
  zoom: number;
};

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
  svgHost: HTMLElement,
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
    svgHost.innerHTML = svg;
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

function iconSvg(name: "up" | "down" | "left" | "right" | "zoomIn" | "zoomOut" | "reset") {
  const paths: Record<typeof name, string> = {
    up: '<path d="m6 15 6-6 6 6" />',
    down: '<path d="m6 9 6 6 6-6" />',
    left: '<path d="m15 18-6-6 6-6" />',
    right: '<path d="m9 18 6-6-6-6" />',
    zoomIn:
      '<circle cx="11" cy="11" r="7" /><path d="m20 20-4.5-4.5" /><path d="M11 8v6" /><path d="M8 11h6" />',
    zoomOut:
      '<circle cx="11" cy="11" r="7" /><path d="m20 20-4.5-4.5" /><path d="M8 11h6" />',
    reset:
      '<path d="M3 12a9 9 0 0 1 15.5-6.2" /><path d="M18 2v5h-5" /><path d="M21 12a9 9 0 0 1-15.5 6.2" /><path d="M6 22v-5h5" />',
  };
  return `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`;
}

function applyDiagramTransform(svgHost: HTMLElement, transform: DiagramTransform) {
  svgHost.style.transform = `translate(${transform.x}px, ${transform.y}px) scale(${transform.zoom})`;
}

function createControlButton(
  icon: Parameters<typeof iconSvg>[0],
  label: string,
  onClick: () => void,
) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "cm-md-mermaid-control-btn";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.innerHTML = iconSvg(icon);
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });
  return button;
}

function createMermaidControls(svgHost: HTMLElement) {
  const transform: DiagramTransform = { x: 0, y: 0, zoom: 1 };
  const update = () => applyDiagramTransform(svgHost, transform);
  const move = (dx: number, dy: number) => {
    transform.x += dx;
    transform.y += dy;
    update();
  };
  const zoom = (delta: number) => {
    transform.zoom = Math.min(
      MAX_ZOOM,
      Math.max(MIN_ZOOM, Number((transform.zoom + delta).toFixed(2))),
    );
    update();
  };
  const reset = () => {
    transform.x = 0;
    transform.y = 0;
    transform.zoom = 1;
    update();
  };

  const controls = document.createElement("div");
  controls.className = "cm-md-mermaid-controls";
  controls.setAttribute("aria-label", "Mermaid 图表视图控制");
  for (const type of ["pointerdown", "mousedown", "mouseup", "dblclick", "touchstart"] as const)
    controls.addEventListener(type, (event) => {
      event.preventDefault();
      event.stopPropagation();
    });

  controls.append(
    document.createElement("span"),
    createControlButton("up", "上移图表", () => move(0, -PAN_STEP)),
    createControlButton("zoomIn", "放大图表", () => zoom(ZOOM_STEP)),
    createControlButton("left", "左移图表", () => move(-PAN_STEP, 0)),
    createControlButton("reset", "重置图表视图", reset),
    createControlButton("right", "右移图表", () => move(PAN_STEP, 0)),
    document.createElement("span"),
    createControlButton("down", "下移图表", () => move(0, PAN_STEP)),
    createControlButton("zoomOut", "缩小图表", () => zoom(-ZOOM_STEP)),
  );
  update();
  return controls;
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
    const stage = document.createElement("div");
    stage.className = "cm-md-mermaid-stage";
    const svgHost = document.createElement("div");
    svgHost.className = "cm-md-mermaid-svg";
    stage.append(svgHost);
    wrap.append(stage, createMermaidControls(svgHost));
    // Click to edit: drop the caret into the source so the block reveals.
    wrap.addEventListener("mousedown", (e) => {
      e.preventDefault();
      view.dispatch({ selection: { anchor: this.from } });
      view.focus();
    });
    const cached = svgCache.get(cacheKey(this.theme, this.code));
    if (cached) svgHost.innerHTML = cached;
    else void renderDiagram(view, this.code, this.theme, svgHost, wrap);
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
