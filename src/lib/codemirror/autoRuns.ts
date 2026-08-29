// The two triggers that run a block without its 运行 button being clicked:
// `run=watch` (a control moved) and `run=open` (the note was opened).
//
// They share one confirmation — the same 运行前二次确认 setting, asked once per
// session (run.ts) — but they are not equally risky, and the difference is
// worth naming. `watch` still starts with a gesture: someone dragged a slider
// in this note. `open` starts with nothing at all, so it is the one place where
// merely opening a file executes code, and it is deliberately limited:
//
//   - it never fires in read-only mode;
//   - it fires once per opening of the note (per `docKey`), so rebuilding the
//     preview extensions — switching view mode, loading the runner table —
//     doesn't spawn a process behind the reader's back;
//   - with 二次确认 on, the first automatic run of the session asks first, and
//     declining leaves everything unrun.
//
// A note that arrives through a git sync therefore cannot execute anything
// before its reader has said yes at least once.

import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

import { useInputStore } from "../../store/useInputStore";
import { useAppStore } from "../../store/useAppStore";
import { runKey } from "../../store/useRunStore";
import { runBlock } from "../codeRun/runBlock";
import { resolveRunner } from "../codeRun/runners";
import {
  fenceInfoOf,
  isCloseFenceLine,
  parseFenceInfo,
  type RunTrigger,
} from "../codeRun/fenceAttrs";
import { codeRunnersChanged } from "./livePreview";

/** Interpreters cost tens of milliseconds to start; a dragged slider emits
 *  changes far faster than that. Only the last position gets a process. */
const DEBOUNCE_MS = 300;

/**
 * Blocks `run=open` has already fired for *in the document currently open*.
 *
 * The trigger has to fire once per opening, and "an opening" is exactly what
 * the store's `docKey` counts: it changes when a file is opened, switched to or
 * reloaded, and does not change when the preview extensions are rebuilt (a
 * view-mode switch, a runner-table update), which would otherwise re-run the
 * block for something the reader never did. Scoping the set to one docKey gives
 * both halves: reopening the note runs it again, rebuilding does not.
 */
let openedDocKey = -1;
const openedRuns = new Set<string>();

interface Target {
  info: string;
  code: string;
}

/** Blocks whose fence asks for `trigger`, optionally bound to `blockId`. */
function targets(
  view: EditorView,
  trigger: RunTrigger,
  blockId?: string,
): Target[] {
  const config = useAppStore.getState().codeRunConfig;
  if (!config.enabled) return [];
  const doc = view.state.doc;
  const found: Target[] = [];
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
    const { lang, attrs } = parseFenceInfo(info);
    const bound =
      blockId === undefined ||
      (attrs.input?.kind === "block" && attrs.input.name === blockId);
    if (attrs.trigger === trigger && bound && j > i + 1 && resolveRunner(lang, config))
      found.push({
        info,
        code: doc.sliceString(doc.line(i + 1).from, doc.line(j - 1).to),
      });
    i = Math.min(j, doc.lines) + 1;
  }
  return found;
}

export const autoRuns = ViewPlugin.fromClass(
  class {
    private timer: ReturnType<typeof setTimeout> | null = null;
    private pending: string | null = null;
    private readonly unsubscribe: () => void;

    constructor(readonly view: EditorView) {
      this.unsubscribe = useInputStore.subscribe((state, previous) => {
        if (state.rev === previous.rev || !state.lastChanged) return;
        this.scheduleWatch(state.lastChanged);
      });
      // The runner table finishes loading after the first file opens, so an
      // open-trigger pass now may find nothing runnable; `update` retries when
      // the table arrives, and `openedRuns` keeps that from running twice.
      this.runOnOpen();
    }

    update(u: ViewUpdate) {
      if (u.transactions.some((tr) => tr.effects.some((e) => e.is(codeRunnersChanged))))
        this.runOnOpen();
    }

    /** Fire every `run=open` block that hasn't run for this opening yet. */
    runOnOpen() {
      if (this.view.state.readOnly) return;
      const { activeFilePath, docKey } = useAppStore.getState();
      if (docKey !== openedDocKey) {
        openedDocKey = docKey;
        openedRuns.clear();
      }
      const filePath = activeFilePath ?? "";
      for (const target of targets(this.view, "open")) {
        const key = runKey(filePath, target.code);
        if (openedRuns.has(key)) continue;
        openedRuns.add(key);
        void runBlock(this.view, target.info, target.code, { auto: true });
      }
    }

    scheduleWatch(changedKey: string) {
      if (this.view.state.readOnly) return;
      const filePath = useAppStore.getState().activeFilePath ?? "";
      const prefix = `${filePath} `;
      if (!changedKey.startsWith(prefix)) return; // another note's block
      this.pending = changedKey.slice(prefix.length);
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.timer = null;
        const blockId = this.pending;
        this.pending = null;
        if (blockId === null) return;
        for (const target of targets(this.view, "watch", blockId))
          void runBlock(this.view, target.info, target.code, { auto: true });
      }, DEBOUNCE_MS);
    }

    destroy() {
      if (this.timer !== null) clearTimeout(this.timer);
      this.unsubscribe();
    }
  },
);
