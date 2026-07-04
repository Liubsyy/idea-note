// Markdown-faithful soft breaks for the live preview.
//
// In markdown a single "\n" inside a paragraph is only a *soft* break — a real
// renderer collapses it to a space, so the lines flow as one wrapped paragraph.
// A real break needs a blank line (two "\n"), which ends the paragraph. The
// stock CodeMirror view shows every source line on its own row, so a single
// "\n" *looks* like a line break, mismatching what the exported markdown
// renders. This fixes that: for each multi-line Paragraph the cursor isn't
// editing, every interior "\n" is replaced with a space so the paragraph reads
// as one flowing block — only a blank line breaks it.
//
// Replacing a line break (joining two lines) must come from a StateField; a
// ViewPlugin may not, which is why this lives apart from livePreview.ts (same
// constraint as math.ts / tablePreview.ts). Because a StateField can't read
// view.hasFocus, a tiny focus-tracking field mirrors it into the state so an
// unfocused editor collapses every paragraph (matching livePreview, which only
// reveals the cursor's source while focused).

import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import {
  EditorState,
  Extension,
  Range,
  StateEffect,
  StateField,
} from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, WidgetType } from "@codemirror/view";

import { parseAdvanced } from "./livePreview";

// --- Focus mirror -----------------------------------------------------------

const setFocus = StateEffect.define<boolean>();

/** Whether the editor is focused, mirrored from the view so the StateField can
 *  see it (a plain StateField has no view to ask). */
const focusField = StateField.define<boolean>({
  create: () => false,
  update(focused, tr) {
    for (const e of tr.effects) if (e.is(setFocus)) return e.value;
    return focused;
  },
});

const focusWatcher = EditorView.updateListener.of((u) => {
  if (u.focusChanged) u.view.dispatch({ effects: setFocus.of(u.view.hasFocus) });
});

// --- Soft-break collapse ----------------------------------------------------

/** A markdown hard break (`two trailing spaces`, trailing `\`, or a trailing
 *  raw HTML `<br>`) keeps its line break — only those, plus blank-line
 *  separators, actually break. */
const HARD_BREAK_RE = /(?: {2,}|\\|<br\s*\/?>)\s*$/i;

/** The single space a soft break collapses to. A widget (not a bare replace)
 *  so the joined words don't run together. */
class SoftBreakWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-md-softbreak";
    s.textContent = " ";
    return s;
  }
  ignoreEvent() {
    return false;
  }
}

function buildSoftWraps(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const doc = state.doc;
  const focused = state.field(focusField, false);
  // Force parsing forward so paragraphs below the lazily-parsed region collapse
  // right away on open, not only after the first interaction.
  const tree = ensureSyntaxTree(state, doc.length, 50) ?? syntaxTree(state);

  tree.iterate({
    enter: (node) => {
      if (node.name !== "Paragraph") return;
      const startLine = doc.lineAt(node.from).number;
      const endLine = doc.lineAt(node.to).number;
      if (endLine <= startLine) return; // single line: no interior break

      // Keep the source visible while the cursor is actively in the paragraph so
      // it stays editable line-by-line. Only while focused — an unfocused editor
      // renders everything (matching livePreview) — and never in read-only mode,
      // where nothing is editable so it always renders collapsed.
      const editing =
        focused &&
        !state.readOnly &&
        state.selection.ranges.some((r) => r.from <= node.to && r.to >= node.from);
      if (editing) return false;

      for (let n = startLine; n < endLine; n++) {
        const line = doc.line(n);
        // A hard break keeps its line break.
        if (HARD_BREAK_RE.test(line.text)) continue;
        const next = doc.line(n + 1);
        // Swallow the "\n" plus the continuation line's leading indent, the way
        // a markdown soft break does, and render a single joining space.
        const lead = next.text.length - next.text.replace(/^\s+/, "").length;
        ranges.push(
          Decoration.replace({ widget: new SoftBreakWidget() }).range(
            line.to,
            next.from + lead,
          ),
        );
      }
      return false;
    },
  });

  return Decoration.set(ranges, true);
}

const softWrapField = StateField.define<DecorationSet>({
  create: (state) => buildSoftWraps(state),
  update(deco, tr) {
    if (
      tr.docChanged ||
      tr.selection ||
      tr.startState.readOnly !== tr.state.readOnly ||
      tr.effects.some((e) => e.is(setFocus) || e.is(parseAdvanced))
    )
      return buildSoftWraps(tr.state);
    return deco.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

// focusField must precede softWrapField so the latter can read it on init.
export const paragraphSoftWrap: Extension = [
  focusField,
  focusWatcher,
  softWrapField,
];
