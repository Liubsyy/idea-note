import { useEffect, useRef } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { cmHighlighting, cmPlainTextTheme, cmTheme } from "../../lib/codemirror/theme";
import type { StructuredKind } from "../../lib/structuredPreview";

/** A separate read-only document, never registered as the source editor. */
export function FormattedCodeView({ text, kind }: { text: string; kind: StructuredKind }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const initialText = useRef(text);
  useEffect(() => {
    if (!host.current) return;
    const language = new Compartment();
    const editor = new EditorView({ parent: host.current, state: EditorState.create({
      doc: initialText.current,
      extensions: [cmPlainTextTheme, cmTheme, cmHighlighting, lineNumbers(),
        EditorView.lineWrapping, EditorState.readOnly.of(true), EditorView.editable.of(false),
        EditorView.contentAttributes.of({ "aria-label": `${kind.toUpperCase()} 格式化视图（只读）`, tabindex: "0" }),
        language.of([])],
    }) });
    view.current = editor;
    void LanguageDescription.matchFilename(languages, `file.${kind}`)?.load().then(support => {
      if (view.current === editor) editor.dispatch({ effects: language.reconfigure(support) });
    }).catch(() => {});
    return () => { view.current = null; editor.destroy(); };
  }, [kind]);
  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== text)
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text } });
  }, [text]);
  return <div className="cm-host structured-formatted-view" ref={host} />;
}
