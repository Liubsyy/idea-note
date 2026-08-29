// The result of a code block, rendered next to it in the document.
//
// A block that draws a table or a chart has to show it where the code is: a
// side panel is fine for a stack trace, useless for a slider you are dragging.
// So a fence carrying `out=<something>` (or a bare `inline`) grows a widget
// holding the latest run for that block.
//
// It sits *above* the code by default. In a finished note the result is the
// content — the number, the table, the diagram — and the script that produced
// it is closer to a footnote; putting the result first also keeps it next to
// the ```input controls that drive it, so a slider and the figure it changes
// stay in one glance. `result=below` moves it under the block.
//
// Nothing is written to the note. The widget reads useRunStore, keyed the same
// way run records are (file + code hash), and updates its own DOM on store
// changes instead of rebuilding the decoration — that is what lets the previous
// result stay on screen while the next run is still starting, so a `watch`
// block doesn't strobe between blank and filled while a slider moves.

import { EditorState, Range, StateField } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";

import {
  blockHeightKey,
  estimatedBlockHeight,
  trackBlockHeight,
  untrackBlockHeight,
} from "./blockHeight";
import {
  fenceInfoOf,
  isCloseFenceLine,
  parseFenceInfo,
  parseOutDirective,
  rendersInline,
  type OutKind,
} from "../codeRun/fenceAttrs";
import { outputText } from "../codeRun/document";
import { renderOutput } from "../codeRun/renderOutput";
import { runKey, useRunStore, type RunRecord } from "../../store/useRunStore";
import { useAppStore } from "../../store/useAppStore";
import { resolveRunner } from "../codeRun/runners";
import { codeRunnersChanged } from "./livePreview";

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
};

const CLEANUPS = new WeakMap<HTMLElement, () => void>();

const statusLabel = (record: RunRecord): string => {
  if (record.status === "running") return "运行中";
  if (record.status === "timeout") return "超时";
  if (record.status === "killed") return "已停止";
  if (record.status === "error") return "启动失败";
  return record.exitCode === 0 || record.exitCode === null
    ? `完成 · ${record.ms} 毫秒`
    : `退出码 ${record.exitCode}`;
};

class ResultWidget extends WidgetType {
  constructor(
    readonly key: string,
    readonly kind: OutKind,
    readonly from: number,
  ) {
    super();
  }
  eq(o: ResultWidget) {
    return o.key === this.key && o.kind === this.kind && o.from === this.from;
  }
  get estimatedHeight() {
    return estimatedBlockHeight(blockHeightKey("result", this.from));
  }

  toDOM(view: EditorView) {
    // Outer element: spacing only. CodeMirror measures a block widget with
    // getBoundingClientRect(), which excludes margins — a margin here would be
    // missing from the height map, and every widget would shift the mapping
    // between a click's y and the line under it (see math/mermaid, same rule).
    const wrap = el("div", "cm-md-result");
    const card = el("div", "cm-md-result-card");
    const head = el("div", "cm-md-result-head");
    const status = el("span", "cm-md-result-status");
    const params = el("span", "cm-md-result-params");
    head.append(status, params);
    const body = el("div", "cm-md-result-body");
    card.append(head, body);
    wrap.append(card);

    /** The run whose output is currently drawn, so we don't redraw per chunk
     *  of the same unchanged text. */
    let shownRunId = -1;
    let shownText = "";

    const paint = (record: RunRecord | undefined) => {
      if (!record) {
        wrap.classList.add("cm-md-result-empty");
        status.textContent = "尚未运行";
        params.textContent = "";
        body.replaceChildren();
        return;
      }
      wrap.classList.remove("cm-md-result-empty");
      wrap.classList.toggle("cm-md-result-running", record.status === "running");
      status.textContent = statusLabel(record);
      params.textContent = record.inputSummary;

      const text = record.error ?? outputText(record);
      // Double buffering: a run that has produced nothing yet keeps the
      // previous result visible rather than blanking the block.
      if (record.status === "running" && !text && shownText) return;
      if (record.runId === shownRunId && text === shownText) return;
      shownRunId = record.runId;
      shownText = text;

      // A failed run prints a traceback, not a table: rendering that through
      // the declared renderer would replace the error with "这不是表格".
      const failed =
        record.error !== null ||
        record.status === "error" ||
        (record.exitCode !== null && record.exitCode !== 0);
      const { kind, body: payload } = parseOutDirective(text, this.kind);
      renderOutput(body, failed ? "text" : kind, payload, () =>
        view.requestMeasure(),
      );
    };

    paint(useRunStore.getState().records.find((r) => r.key === this.key));
    const unsubscribe = useRunStore.subscribe((state) => {
      paint(state.records.find((r) => r.key === this.key));
      view.requestMeasure();
    });
    CLEANUPS.set(wrap, unsubscribe);

    trackBlockHeight(wrap, () => blockHeightKey("result", this.from));
    return wrap;
  }

  destroy(dom: HTMLElement) {
    CLEANUPS.get(dom)?.();
    CLEANUPS.delete(dom);
    untrackBlockHeight(dom);
  }
  /** Let clicks reach the rendered result (sorting a table, following a link)
   *  instead of moving the caret. */
  ignoreEvent() {
    return true;
  }
}

function buildResults(state: EditorState): DecorationSet {
  const config = useAppStore.getState().codeRunConfig;
  if (!config.enabled) return Decoration.none;
  const filePath = useAppStore.getState().activeFilePath ?? "";
  const ranges: Range<Decoration>[] = [];
  const doc = state.doc;

  let i = 1;
  while (i <= doc.lines) {
    const line = doc.line(i);
    const info = fenceInfoOf(line.text);
    if (info === null) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j <= doc.lines && !isCloseFenceLine(doc.line(j).text)) j++;
    const closeLine = Math.min(j, doc.lines);
    const { lang, attrs } = parseFenceInfo(info);
    if (rendersInline(attrs) && resolveRunner(lang, config) && j > i + 1) {
      const code = doc.sliceString(doc.line(i + 1).from, doc.line(j - 1).to);
      const below = attrs.placement === "below";
      // Above: the opening fence's start, side -1 so the widget precedes the
      // block. Below: the closing fence's end, side 1 so it follows.
      const at = below ? doc.line(closeLine).to : line.from;
      ranges.push(
        Decoration.widget({
          widget: new ResultWidget(runKey(filePath, code), attrs.out, at),
          block: true,
          side: below ? 1 : -1,
        }).range(at),
      );
    }
    i = closeLine + 1;
  }
  return Decoration.set(ranges, true);
}

export const resultBlock = StateField.define<DecorationSet>({
  create: (state) => buildResults(state),
  update(deco, tr) {
    // Only the document decides where results go — a selection change must not
    // rebuild these widgets, or clicking into a block would restart its render.
    // The runner table is the other input: it decides whether a language is
    // runnable at all, and it finishes loading after the first file opens.
    if (tr.docChanged || tr.effects.some((e) => e.is(codeRunnersChanged)))
      return buildResults(tr.state);
    return deco.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});
