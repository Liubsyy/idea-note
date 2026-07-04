import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/**
 * Auto-close a fenced code block when the user types the opening ``` at the
 * start of a line. Toolbar insertion lives in markdownCommands; this covers the
 * natural typing path.
 */
export const markdownAutoCloseFences = EditorView.inputHandler.of(
  (view, from, to, text) => {
    if (from !== to) return false;
    if (text !== "`" && text !== "```") return false;

    const { state } = view;
    const line = state.doc.lineAt(from);
    const before = state.sliceDoc(line.from, from);
    const after = state.sliceDoc(from, line.to);
    const opening =
      text === "`"
        ? /^(\s*)``$/.exec(before)
        : /^(\s*)$/.exec(before);

    if (!opening || after.trim() !== "") return false;

    const indent = opening[1];
    const insert = text === "`" ? "`\n" : "```\n";
    const close = `${indent}\n${indent}\`\`\``;
    const cursor = from + insert.length + indent.length;

    view.dispatch({
      changes: { from, to, insert: insert + close },
      selection: EditorSelection.cursor(cursor),
    });
    return true;
  },
);
